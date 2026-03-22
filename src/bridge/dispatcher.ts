import type { WeixinMessage } from "../wechat/types.js";
import { MessageType, MessageItemType, TypingStatus } from "../wechat/types.js";
import { sendTyping } from "../wechat/api.js";
import type { WeixinApiOptions } from "../wechat/api.js";
import { sendTextMessage, markdownToPlainText } from "../wechat/send.js";
import { setContextToken, getContextToken } from "../wechat/context-token.js";
import { getAgent, getRegisteredTypes } from "../agent/registry.js";
import { getOrCreateSession, updateSession, resetAgentSession } from "../storage/sessions.js";
import { isUserAllowed } from "../auth/allowlist.js";
import { formatResponse } from "./formatter.js";
import { chunkText } from "./chunker.js";
import { logger } from "../util/logger.js";
import { redactUserId } from "../util/redact.js";
import type { AgentType, AppConfig } from "../types.js";

const TYPING_INTERVAL_MS = 10_000;

export interface DispatcherDeps {
  apiOpts: WeixinApiOptions;
  config: AppConfig;
}

export function createDispatcher(deps: DispatcherDeps) {
  const { apiOpts, config } = deps;

  return async function dispatch(msg: WeixinMessage, typingTicket: string): Promise<void> {
    // Only process USER messages
    if (msg.message_type !== MessageType.USER) return;

    const userId = msg.from_user_id;
    if (!userId) return;

    // Cache context_token
    if (msg.context_token) {
      setContextToken(userId, msg.context_token);
    }

    // Extract text
    const text = extractText(msg);
    if (!text) return;

    // Allowlist check
    if (!isUserAllowed(userId)) {
      logger.warn(`User not in allowlist: ${redactUserId(userId)}`);
      return;
    }

    logger.info(`Message from=${redactUserId(userId)} len=${text.length}`);

    // Parse commands
    const trimmed = text.trim();
    const firstWord = trimmed.split(/\s/)[0].toLowerCase();

    switch (firstWord) {
      case "/claude":
        await handleSwitch(userId, "claude");
        return;
      case "/codex":
        await handleSwitch(userId, "codex");
        return;
      case "/reset":
        await handleReset(userId);
        return;
      case "/status":
        await handleStatus(userId);
        return;
      case "/help":
        await handleHelp(userId);
        return;
      case "/cwd":
        await handleCwd(userId, trimmed.slice(4).trim());
        return;
    }

    // Route to agent
    const session = getOrCreateSession(userId, config.defaultAgent, config.codex.workingDirectory);

    // Start typing indicator
    const typingController = new AbortController();
    startTypingLoop(userId, typingTicket, typingController.signal);

    try {
      const agent = getAgent(session.agentType);
      const result = await agent.run({
        userId,
        prompt: trimmed,
        cwd: session.cwd,
      });

      typingController.abort();

      const response = formatResponse(result.text, result.toolsUsed, result.isError);
      const plainText = markdownToPlainText(response);
      const chunks = chunkText(plainText, config.textChunkLimit);

      await sendChunks(userId, chunks);
    } catch (err) {
      typingController.abort();
      logger.error(`Agent error for user=${redactUserId(userId)}: ${String(err)}`);
      await sendReply(userId, `Error: ${String(err)}`);
    }
  };

  async function handleSwitch(userId: string, agentType: AgentType): Promise<void> {
    const types = getRegisteredTypes();
    if (!types.includes(agentType)) {
      await sendReply(userId, `Agent "${agentType}" is not available. Available: ${types.join(", ")}`);
      return;
    }
    const session = getOrCreateSession(userId, config.defaultAgent, config.codex.workingDirectory);
    if (session.agentType === agentType) {
      await sendReply(userId, `Already using ${agentType}.`);
      return;
    }
    updateSession(userId, { agentType });
    await sendReply(userId, `Switched to ${agentType}. Previous ${session.agentType} session is preserved.`);
  }

  async function handleReset(userId: string): Promise<void> {
    const session = getOrCreateSession(userId, config.defaultAgent, config.codex.workingDirectory);
    const agent = getAgent(session.agentType);
    agent.resetSession(userId);
    resetAgentSession(userId, session.agentType);
    await sendReply(userId, `${session.agentType} session reset. Starting fresh.`);
  }

  async function handleStatus(userId: string): Promise<void> {
    const session = getOrCreateSession(userId, config.defaultAgent, config.codex.workingDirectory);
    const agent = getAgent(session.agentType);
    const agentStatus = agent.getStatus(userId);
    const lines = [
      `Current agent: ${session.agentType}`,
      `CWD: ${session.cwd}`,
      `Last active: ${new Date(session.lastActive).toISOString()}`,
      agentStatus,
    ];
    await sendReply(userId, lines.join("\n"));
  }

  async function handleHelp(userId: string): Promise<void> {
    const types = getRegisteredTypes();
    const lines = [
      "Commands:",
      ...types.map((t) => `  /${t} - Switch to ${t}`),
      "  /reset - Reset current agent session",
      "  /status - Show current status",
      "  /help - Show this help",
      "  /cwd <path> - Change working directory",
      "",
      `Available agents: ${types.join(", ")}`,
      "Send any text to chat with the current agent.",
    ];
    await sendReply(userId, lines.join("\n"));
  }

  async function handleCwd(userId: string, newCwd: string): Promise<void> {
    const session = getOrCreateSession(userId, config.defaultAgent, config.codex.workingDirectory);
    if (!newCwd) {
      await sendReply(userId, `Current CWD: ${session.cwd}`);
    } else {
      updateSession(userId, { cwd: newCwd });
      await sendReply(userId, `Working directory changed to: ${newCwd}`);
    }
  }

  async function sendReply(userId: string, text: string): Promise<void> {
    const contextToken = getContextToken(userId);
    if (!contextToken) {
      logger.error(`No contextToken for user=${redactUserId(userId)}, cannot send reply`);
      return;
    }
    const chunks = chunkText(text, config.textChunkLimit);
    await sendChunks(userId, chunks);
  }

  async function sendChunks(userId: string, chunks: string[]): Promise<void> {
    const contextToken = getContextToken(userId);
    for (const chunk of chunks) {
      try {
        await sendTextMessage({
          to: userId,
          text: chunk,
          opts: { ...apiOpts, contextToken },
        });
      } catch (err) {
        logger.error(`Failed to send chunk to=${redactUserId(userId)}: ${String(err)}`);
      }
      if (chunks.length > 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  function startTypingLoop(userId: string, ticket: string, signal: AbortSignal): void {
    const sendTypingOnce = async () => {
      try {
        await sendTyping({
          baseUrl: apiOpts.baseUrl,
          token: apiOpts.token,
          routeTag: apiOpts.routeTag,
          body: {
            ilink_user_id: userId,
            typing_ticket: ticket,
            status: TypingStatus.TYPING,
          },
        });
      } catch {
        // Typing failures are silently ignored
      }
    };

    void sendTypingOnce();

    const interval = setInterval(() => {
      if (signal.aborted) {
        clearInterval(interval);
        return;
      }
      void sendTypingOnce();
    }, TYPING_INTERVAL_MS);

    signal.addEventListener("abort", () => clearInterval(interval), { once: true });
  }
}

function extractText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return "";
}
