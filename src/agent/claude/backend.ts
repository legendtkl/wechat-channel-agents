import {
  query,
  type Options,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentRequest, AgentResponse } from "../interface.js";
import type { AppConfig } from "../../types.js";
import { getSession, updateSession } from "../../storage/sessions.js";
import { createHooks } from "./hooks.js";
import { logger } from "../../util/logger.js";

const DEFAULT_IMAGE_PROMPT = "Please analyze the attached image.";

function extractText(msg: SDKAssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function buildPrompt(req: AgentRequest): string | AsyncIterable<SDKUserMessage> {
  if (!req.images?.length) {
    return req.prompt;
  }

  const text = req.prompt.trim() || DEFAULT_IMAGE_PROMPT;
  const content = [
    { type: "text", text },
    ...req.images.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data.toString("base64"),
      },
    })),
  ];

  return (async function* multimodalPrompt(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content,
      } as SDKUserMessage["message"],
    };
  }());
}

export class ClaudeBackend implements AgentBackend {
  readonly type = "claude" as const;
  readonly supportsImages = true;

  constructor(private config: AppConfig) {}

  async run(req: AgentRequest): Promise<AgentResponse> {
    const session = getSession(req.userId);
    const toolsUsed: string[] = [];
    let resultText = "";
    let sessionId = "";
    let isError = false;

    const options: Options = {
      cwd: req.cwd,
      allowedTools: [
        "Read", "Edit", "Write", "Bash", "Grep", "Glob",
        "WebSearch", "WebFetch", "Agent",
      ],
      permissionMode: "bypassPermissions",
      hooks: createHooks(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: this.config.anthropicBaseUrl,
        ANTHROPIC_AUTH_TOKEN: this.config.anthropicAuthToken,
      },
      maxTurns: 30,
    };

    // Resume existing session if available
    if (session?.claudeSessionId) {
      options.resume = session.claudeSessionId;
      logger.debug(`Resuming Claude session for user=${req.userId}`);
    }

    try {
      const stream = query({ prompt: buildPrompt(req), options });
      const lastAssistantTexts: string[] = [];

      for await (const msg of stream) {
        sessionId = msg.session_id;

        switch (msg.type) {
          case "assistant": {
            const text = extractText(msg);
            if (text) {
              lastAssistantTexts.push(text);
            }
            for (const block of msg.message.content) {
              if (block.type === "tool_use") {
                toolsUsed.push(block.name);
              }
            }
            break;
          }

          case "result": {
            const result = msg as SDKResultMessage;
            isError = result.is_error;
            if (result.subtype === "success") {
              resultText = result.result;
            }
            break;
          }
        }
      }

      if (!resultText && lastAssistantTexts.length > 0) {
        resultText = lastAssistantTexts[lastAssistantTexts.length - 1];
      }

      // Save session for future resume
      if (sessionId) {
        updateSession(req.userId, { claudeSessionId: sessionId });
      }

      return {
        text: resultText || "(No response)",
        isError,
        toolsUsed,
      };
    } catch (err) {
      logger.error(`Claude agent query failed: user=${req.userId} err=${String(err)}`);
      return {
        text: `Error: ${String(err)}`,
        isError: true,
        toolsUsed,
      };
    }
  }

  resetSession(userId: string): void {
    updateSession(userId, { claudeSessionId: undefined });
    logger.info(`Claude session reset for user=${userId}`);
  }

  getStatus(userId: string): string {
    const session = getSession(userId);
    if (session?.claudeSessionId) {
      return `Claude session: ${session.claudeSessionId.slice(0, 8)}...`;
    }
    return "Claude: no active session";
  }
}
