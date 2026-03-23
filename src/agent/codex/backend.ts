import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadItem, SandboxMode } from "@openai/codex-sdk";
import type { AgentBackend, AgentRequest, AgentResponse } from "../interface.js";
import type { AppConfig } from "../../types.js";
import { getSession, updateSession } from "../../storage/sessions.js";
import { logger } from "../../util/logger.js";

interface PerUserCodex {
  codex: Codex;
  thread: import("@openai/codex-sdk").Thread | null;
}

export class CodexBackend implements AgentBackend {
  readonly type = "codex" as const;
  private users = new Map<string, PerUserCodex>();
  private config: AppConfig;
  private codexEnv: Record<string, string>;

  constructor(config: AppConfig) {
    this.config = config;
    this.codexEnv = this.buildCodexEnv();
  }

  private getOrCreate(userId: string): PerUserCodex {
    let entry = this.users.get(userId);
    if (!entry) {
      entry = {
        codex: new Codex({
          env: this.codexEnv,
        }),
        thread: null,
      };
      this.users.set(userId, entry);
    }
    return entry;
  }

  private buildCodexEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "OPENAI_BASE_URL" && k !== "OPENAIBASEURL") {
        env[k] = v;
      }
    }
    return env;
  }

  private buildThreadOptions(): import("@openai/codex-sdk").ThreadOptions {
    const opts: import("@openai/codex-sdk").ThreadOptions = {
      workingDirectory: this.config.codex.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: (this.config.codex.sandboxMode || "danger-full-access") as SandboxMode,
    };
    if (this.config.codex.model) {
      opts.model = this.config.codex.model;
    }
    return opts;
  }

  private ensureThread(userId: string): PerUserCodex {
    const entry = this.getOrCreate(userId);
    if (!entry.thread) {
      const session = getSession(userId);
      const savedThreadId = session?.codexThreadId;

      if (savedThreadId) {
        try {
          entry.thread = entry.codex.resumeThread(savedThreadId, this.buildThreadOptions());
          logger.info(`Resumed Codex thread for user=${userId}: ${savedThreadId}`);
        } catch (err) {
          logger.warn(`Failed to resume Codex thread ${savedThreadId}: ${String(err)}, starting new`);
          entry.thread = entry.codex.startThread(this.buildThreadOptions());
        }
      } else {
        entry.thread = entry.codex.startThread(this.buildThreadOptions());
        logger.info(`Started new Codex thread for user=${userId}`);
      }
    }
    return entry;
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    const entry = this.ensureThread(req.userId);
    const toolsUsed: string[] = [];

    try {
      const parts: string[] = [];
      const { events } = await entry.thread!.runStreamed(req.prompt);

      for await (const event of events) {
        for (const mapped of this.mapEvent(event)) {
          switch (mapped.type) {
            case "text":
              parts.push(mapped.text);
              break;
            case "command":
              toolsUsed.push("Bash");
              parts.push(`> ${mapped.command}`);
              if (mapped.output) {
                parts.push(mapped.output);
              }
              break;
            case "file_change":
              toolsUsed.push("Edit");
              parts.push(`[file ${mapped.action}: ${mapped.path}]`);
              break;
            case "error":
              parts.push(`Error: ${mapped.message}`);
              break;
            case "turn_complete":
              break;
          }
        }
      }

      // Save thread ID
      const threadId = entry.thread?.id;
      if (threadId) {
        updateSession(req.userId, { codexThreadId: threadId });
      }

      return {
        text: parts.join("\n") || "(No response)",
        isError: false,
        toolsUsed,
      };
    } catch (err) {
      logger.error(`Codex error for user=${req.userId}: ${String(err)}`);
      return {
        text: `Error: ${String(err)}`,
        isError: true,
        toolsUsed,
      };
    }
  }

  resetSession(userId: string): void {
    this.users.delete(userId);
    updateSession(userId, { codexThreadId: undefined });
    logger.info(`Codex session reset for user=${userId}`);
  }

  getStatus(userId: string): string {
    const session = getSession(userId);
    if (session?.codexThreadId) {
      return `Codex thread: ${session.codexThreadId.slice(0, 8)}...`;
    }
    return "Codex: no active thread";
  }

  private *mapEvent(event: ThreadEvent): Generator<CodexEvent> {
    switch (event.type) {
      case "item.completed":
        yield* this.mapItem(event.item);
        break;
      case "turn.completed":
        yield { type: "turn_complete" };
        break;
      case "turn.failed":
        yield { type: "error", message: event.error.message };
        break;
      case "error":
        yield { type: "error", message: event.message };
        break;
    }
  }

  private *mapItem(item: ThreadItem): Generator<CodexEvent> {
    switch (item.type) {
      case "agent_message":
        yield { type: "text", text: item.text };
        break;
      case "command_execution":
        yield {
          type: "command",
          command: item.command,
          output: item.aggregated_output || undefined,
        };
        break;
      case "file_change":
        for (const change of item.changes) {
          yield {
            type: "file_change",
            path: change.path,
            action: change.kind,
          };
        }
        break;
      case "error":
        yield { type: "error", message: item.message };
        break;
    }
  }
}

type CodexEvent =
  | { type: "text"; text: string }
  | { type: "command"; command: string; output?: string }
  | { type: "file_change"; path: string; action: string }
  | { type: "turn_complete" }
  | { type: "error"; message: string };
