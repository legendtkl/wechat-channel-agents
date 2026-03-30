import type { WeixinMessage } from "../wechat/types.js";
import { MessageType, MessageItemType, TypingStatus } from "../wechat/types.js";
import { sendTyping } from "../wechat/api.js";
import type { WeixinApiOptions } from "../wechat/api.js";
import { sendTextMessage, markdownToPlainText } from "../wechat/send.js";
import { setContextToken, getContextToken } from "../wechat/context-token.js";
import { getAgent, getRegisteredTypes } from "../agent/registry.js";
import { getOrCreateSession, updateSession, resetAgentSession, listSessions, resumeAgentSession, resumeBySessionId } from "../storage/sessions.js";
import type { AgentSessionListEntry } from "../storage/sessions.js";
import { listClaudeCliSessions, listCodexCliSessions } from "../storage/external-sessions.js";
import type { ExternalSession } from "../storage/external-sessions.js";
import { hasAdminUsers, isUserAdmin, isUserAllowed } from "../auth/allowlist.js";
import { resolveAvailableAgentType } from "./agent-resolution.js";
import { formatResponse, toolUseSummary } from "./formatter.js";
import { chunkText } from "./chunker.js";
import { createStreamingSender } from "./streaming-sender.js";
import { logger } from "../util/logger.js";
import { redactUserId } from "../util/redact.js";
import { buildConversationKey, type AgentType, type AppConfig } from "../types.js";

const TYPING_INTERVAL_MS = 10_000;
const STREAM_FLUSH_INTERVAL_MS = 2_000;
const STREAM_FLUSH_CHARS = 300;

export interface DispatcherDeps {
  config: AppConfig;
  onLogout?: () => Promise<void>;
  onLogin?: () => Promise<{ accountId: string }>;
  listAccounts?: () => string[];
}

export function createDispatcher(deps: DispatcherDeps) {
  const { config } = deps;

  return async function dispatch(params: {
    accountId: string;
    apiOpts: WeixinApiOptions;
    msg: WeixinMessage;
    typingTicket: string;
  }): Promise<void> {
    const { accountId, apiOpts, msg, typingTicket } = params;

    // Only process USER messages
    if (msg.message_type !== MessageType.USER) return;

    const userId = msg.from_user_id;
    if (!userId) return;
    const conversationKey = buildConversationKey(accountId, userId);

    // Cache context_token
    if (msg.context_token) {
      setContextToken(accountId, userId, msg.context_token);
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
        await handleSwitch(accountId, apiOpts, userId, conversationKey, "claude");
        return;
      case "/codex":
        await handleSwitch(accountId, apiOpts, userId, conversationKey, "codex");
        return;
      case "/reset":
        await handleReset(accountId, apiOpts, userId, conversationKey);
        return;
      case "/status":
        await handleStatus(accountId, apiOpts, userId, conversationKey);
        return;
      case "/help":
        await handleHelp(accountId, apiOpts, userId);
        return;
      case "/sessions":
        await handleSessions(accountId, apiOpts, userId, conversationKey, trimmed.slice(9).trim());
        return;
      case "/resume":
        await handleResume(accountId, apiOpts, userId, conversationKey, trimmed.slice(7).trim());
        return;
      case "/cwd":
        await handleCwd(accountId, apiOpts, userId, conversationKey, trimmed.slice(4).trim());
        return;
      case "/login":
        await handleLogin(accountId, apiOpts, userId);
        return;
      case "/logout":
        await handleLogout(accountId, apiOpts, userId);
        return;
    }

    // Route to agent
    const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
    const agentType = ensureSessionAgentAvailable(conversationKey, userId, session);
    let streamedText = "";
    const sender = createStreamingSender({
      send: (text) => sendChunkSafely(accountId, apiOpts, userId, text),
      flushIntervalMs: STREAM_FLUSH_INTERVAL_MS,
      flushChars: STREAM_FLUSH_CHARS,
      maxChunkLen: config.textChunkLimit,
    });

    // Start typing indicator
    const typingController = new AbortController();
    startTypingLoop(apiOpts, userId, typingTicket, typingController.signal);

    try {
      const agent = getAgent(agentType);
      const result = await agent.run({
        userId: conversationKey,
        prompt: trimmed,
        cwd: session.cwd,
        onTextDelta: async (text) => {
          if (!text) return;
          streamedText += text;
          await sender.push(text);
        },
      });

      typingController.abort();

      if (streamedText) {
        await sender.finish(buildStreamingFinalTail(
          userId,
          result.text,
          streamedText,
          result.toolsUsed,
          result.isError,
        ));
      } else {
        const response = formatResponse(result.text, result.toolsUsed, result.isError);
        const plainText = markdownToPlainText(response);
        const chunks = chunkText(plainText, config.textChunkLimit);
        await sendChunks(accountId, apiOpts, userId, chunks);
      }
    } catch (err) {
      typingController.abort();
      logger.error(`Agent error for user=${redactUserId(userId)}: ${String(err)}`);
      if (streamedText) {
        await sender.finish();
      }
      await sendReply(accountId, apiOpts, userId, `Error: ${String(err)}`);
    }
  };

  async function handleSwitch(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
    agentType: AgentType,
  ): Promise<void> {
    const types = getRegisteredTypes();
    if (!types.includes(agentType)) {
      await sendReply(accountId, apiOpts, userId, `Agent "${agentType}" is not available. Available: ${types.join(", ")}`);
      return;
    }
    const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
    const currentAgentType = ensureSessionAgentAvailable(conversationKey, userId, session);
    if (currentAgentType === agentType) {
      await sendReply(accountId, apiOpts, userId, `Already using ${agentType}.`);
      return;
    }
    updateSession(conversationKey, { agentType });
    await sendReply(
      accountId,
      apiOpts,
      userId,
      `Switched to ${agentType}. Previous ${currentAgentType} session is preserved.`,
    );
  }

  async function handleReset(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
  ): Promise<void> {
    const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
    const agentType = ensureSessionAgentAvailable(conversationKey, userId, session);
    const agent = getAgent(agentType);
    agent.resetSession(conversationKey);
    resetAgentSession(conversationKey, agentType);
    await sendReply(accountId, apiOpts, userId, `${agentType} session reset. Starting fresh.`);
  }

  function toExternalEntries(externals: ExternalSession[]): AgentSessionListEntry[] {
    return externals.map((ext) => ({
      index: 0, // will be re-assigned by listSessions
      sessionId: ext.id,
      cwd: ext.cwd,
      project: ext.project,
      timestamp: ext.modifiedAt,
      isActive: false,
      source: "cli" as const,
    }));
  }

  function formatSessionEntries(agentLabel: string, entries: AgentSessionListEntry[]): string[] {
    const lines: string[] = [`[${agentLabel}]`];
    for (const entry of entries) {
      const idPart = entry.sessionId ? entry.sessionId.slice(0, 8) + "..." : "none";
      const time = new Date(entry.timestamp).toLocaleString();
      const proj = entry.project ? ` ${entry.project}` : "";
      const tag = entry.source === "cli" ? " [cli]" : "";
      if (entry.isActive) {
        lines.push(`  * [active] (${idPart}) - ${entry.cwd} - ${time}`);
      } else {
        lines.push(`  ${entry.index}. (${idPart})${tag}${proj} - ${entry.cwd} - ${time}`);
      }
    }
    return lines;
  }

  function parseAgentTypeArg(arg: string): AgentType | null {
    const lower = arg.toLowerCase();
    if (lower === "claude" || lower === "codex") return lower;
    return null;
  }

  function buildSessionList(conversationKey: string, filter?: AgentType | null) {
    const externalClaude = (!filter || filter === "claude") ? toExternalEntries(listClaudeCliSessions()) : [];
    const externalCodex = (!filter || filter === "codex") ? toExternalEntries(listCodexCliSessions()) : [];
    return listSessions(conversationKey, externalClaude, externalCodex);
  }

  async function handleSessions(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
    arg: string,
  ): Promise<void> {
    getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);

    const filter = arg ? parseAgentTypeArg(arg) : null;
    if (arg && !filter) {
      await sendReply(accountId, apiOpts, userId, "Usage: /sessions [claude|codex]");
      return;
    }

    const result = buildSessionList(conversationKey, filter);

    const lines: string[] = [];
    if (!filter || filter === "claude") {
      lines.push(...formatSessionEntries("Claude", result.claude));
    }
    if (!filter || filter === "codex") {
      if (lines.length > 0) lines.push("");
      lines.push(...formatSessionEntries("Codex", result.codex));
    }

    lines.push("");
    lines.push("Use /resume <claude|codex> <n> to restore a session.");
    await sendReply(accountId, apiOpts, userId, lines.join("\n"));
  }

  async function handleResume(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
    arg: string,
  ): Promise<void> {
    const parts = arg.split(/\s+/).filter(Boolean);

    if (parts.length < 1) {
      await sendReply(accountId, apiOpts, userId, "Usage: /resume <claude|codex> <n>\nUse /sessions to see available sessions.");
      return;
    }

    let agentType: AgentType;
    let indexStr: string;

    if (parts.length === 1) {
      const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
      agentType = session.agentType;
      indexStr = parts[0];
    } else {
      const parsed = parseAgentTypeArg(parts[0]);
      if (!parsed) {
        await sendReply(accountId, apiOpts, userId, "Usage: /resume <claude|codex> <n>\nUse /sessions to see available sessions.");
        return;
      }
      agentType = parsed;
      indexStr = parts[1];
    }

    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index < 1) {
      await sendReply(accountId, apiOpts, userId, "Usage: /resume <claude|codex> <n>\nUse /sessions to see available sessions.");
      return;
    }

    // Build the same merged list to resolve index
    const allSessions = buildSessionList(conversationKey, agentType);
    const entries = agentType === "claude" ? allSessions.claude : allSessions.codex;
    const target = entries.find((e) => e.index === index);

    if (!target?.sessionId) {
      await sendReply(accountId, apiOpts, userId, `${agentType} session #${index} not found. Use /sessions ${agentType} to see available sessions.`);
      return;
    }

    // If it's from bot history, use the existing resume function
    // If it's from CLI, use resumeBySessionId
    if (target.source === "bot") {
      const restored = resumeAgentSession(conversationKey, agentType, index - 1);
      if (!restored) {
        await sendReply(accountId, apiOpts, userId, `${agentType} session #${index} not found.`);
        return;
      }
      const idPart = restored.sessionId.slice(0, 8) + "...";
      await sendReply(accountId, apiOpts, userId, `Resumed ${restored.agentType} session (${idPart}), cwd: ${restored.cwd}`);
    } else {
      const restored = resumeBySessionId(conversationKey, agentType, target.sessionId, target.cwd, config.defaultAgent, config.codex.workingDirectory);
      const idPart = restored.sessionId.slice(0, 8) + "...";
      await sendReply(accountId, apiOpts, userId, `Resumed ${restored.agentType} CLI session (${idPart}), cwd: ${restored.cwd}`);
    }
  }

  async function handleStatus(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
  ): Promise<void> {
    const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
    const agentType = ensureSessionAgentAvailable(conversationKey, userId, session);
    const agent = getAgent(agentType);
    const agentStatus = agent.getStatus(conversationKey);
    const lines = [
      `Current bot account: ${accountId}`,
      `Connected bot accounts: ${deps.listAccounts?.().join(", ") ?? accountId}`,
      `Current agent: ${agentType}`,
      `CWD: ${session.cwd}`,
      `Last active: ${new Date(session.lastActive).toISOString()}`,
      agentStatus,
    ];
    await sendReply(accountId, apiOpts, userId, lines.join("\n"));
  }

  async function handleHelp(accountId: string, apiOpts: WeixinApiOptions, userId: string): Promise<void> {
    const types = getRegisteredTypes();
    const loginHelp = hasAdminUsers()
      ? "  /login - Add another bot account by QR login (admin only)"
      : "  /login - Add another bot account by QR login (disabled until adminUsers is configured)";
    const logoutHelp = hasAdminUsers()
      ? "  /logout - Log out all bot accounts and stop service (admin only)"
      : "  /logout - Log out all bot accounts and stop service (disabled until adminUsers is configured)";
    const lines = [
      "Commands:",
      ...types.map((t) => `  /${t} - Switch to ${t}`),
      "  /reset - Reset current agent session",
      "  /sessions [claude|codex] - List sessions per agent",
      "  /resume <claude|codex> <n> - Resume a session",
      "  /status - Show current status",
      "  /help - Show this help",
      "  /cwd <path> - Change working directory",
      loginHelp,
      logoutHelp,
      "",
      `Available agents: ${types.join(", ")}`,
      `Current bot account: ${accountId}`,
      "Send any text to chat with the current agent.",
    ];
    await sendReply(accountId, apiOpts, userId, lines.join("\n"));
  }

  async function handleCwd(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    conversationKey: string,
    newCwd: string,
  ): Promise<void> {
    const session = getOrCreateSession(conversationKey, config.defaultAgent, config.codex.workingDirectory);
    if (!newCwd) {
      await sendReply(accountId, apiOpts, userId, `Current CWD: ${session.cwd}`);
    } else {
      updateSession(conversationKey, { cwd: newCwd });
      await sendReply(accountId, apiOpts, userId, `Working directory changed to: ${newCwd}`);
    }
  }

  async function handleLogin(accountId: string, apiOpts: WeixinApiOptions, userId: string): Promise<void> {
    if (!hasAdminUsers()) {
      logger.warn(`Login command denied for user=${redactUserId(userId)}: no admin users configured`);
      await sendReply(accountId, apiOpts, userId, "Command /login is disabled until adminUsers is configured.");
      return;
    }

    if (!isUserAdmin(userId)) {
      logger.warn(`Login command denied for non-admin user=${redactUserId(userId)}`);
      await sendReply(accountId, apiOpts, userId, "Command /login is restricted to admin users.");
      return;
    }

    if (!deps.onLogin) {
      await sendReply(accountId, apiOpts, userId, "Account login is not available in this runtime.");
      return;
    }

    await sendReply(
      accountId,
      apiOpts,
      userId,
      "Starting QR login for an additional bot account. Check the terminal to scan the QR code.",
    );

    try {
      const result = await deps.onLogin();
      await sendReply(
        accountId,
        apiOpts,
        userId,
        `Additional bot account connected: ${result.accountId}`,
      );
    } catch (err) {
      await sendReply(
        accountId,
        apiOpts,
        userId,
        `Failed to add bot account: ${String(err)}`,
      );
    }
  }

  async function handleLogout(accountId: string, apiOpts: WeixinApiOptions, userId: string): Promise<void> {
    if (!hasAdminUsers()) {
      logger.warn(`Logout command denied for user=${redactUserId(userId)}: no admin users configured`);
      await sendReply(accountId, apiOpts, userId, "Command /logout is disabled until adminUsers is configured.");
      return;
    }

    if (!isUserAdmin(userId)) {
      logger.warn(`Logout command denied for non-admin user=${redactUserId(userId)}`);
      await sendReply(accountId, apiOpts, userId, "Command /logout is restricted to admin users.");
      return;
    }

    await sendReply(
      accountId,
      apiOpts,
      userId,
      "Logging out all bot accounts. Local credentials will be cleared and the service will stop. Restart npm run dev or use /login after restart to scan a new QR code.",
    );

    await deps.onLogout?.();
  }

  async function sendReply(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    text: string,
  ): Promise<void> {
    const contextToken = getContextToken(accountId, userId);
    if (!contextToken) {
      logger.error(`No contextToken for accountId=${accountId} user=${redactUserId(userId)}, cannot send reply`);
      return;
    }
    const chunks = chunkText(text, config.textChunkLimit);
    await sendChunks(accountId, apiOpts, userId, chunks);
  }

  async function sendChunks(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    chunks: string[],
  ): Promise<void> {
    for (const chunk of chunks) {
      await sendChunkSafely(accountId, apiOpts, userId, chunk);
      if (chunks.length > 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  function startTypingLoop(
    apiOpts: WeixinApiOptions,
    userId: string,
    ticket: string,
    signal: AbortSignal,
  ): void {
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

  async function sendChunk(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    text: string,
  ): Promise<void> {
    const contextToken = getContextToken(accountId, userId);
    await sendTextMessage({
      to: userId,
      text,
      opts: { ...apiOpts, contextToken },
    });
  }

  async function sendChunkSafely(
    accountId: string,
    apiOpts: WeixinApiOptions,
    userId: string,
    text: string,
  ): Promise<void> {
    try {
      await sendChunk(accountId, apiOpts, userId, text);
    } catch (err) {
      logger.error(`Failed to send chunk accountId=${accountId} to=${redactUserId(userId)}: ${String(err)}`);
    }
  }

  function buildStreamingFinalTail(
    userId: string,
    finalText: string,
    streamedText: string,
    toolsUsed: string[],
    isError: boolean,
  ): string {
    const parts: string[] = [];
    if (finalText.startsWith(streamedText)) {
      const remaining = finalText.slice(streamedText.length);
      if (remaining) {
        parts.push(remaining);
      }
    } else if (finalText !== streamedText) {
      logger.warn(`Final streamed text mismatch for user=${redactUserId(userId)}; appending final body`);
      parts.push(finalText);
    }

    const summary = toolUseSummary(toolsUsed);
    if (summary) {
      parts.push(summary);
    }

    if (isError) {
      if (parts.length > 0) {
        parts[0] = `[Error] ${parts[0]}`;
      } else {
        parts.push("[Error]");
      }
    }

    return parts.join("\n\n");
  }

  function ensureSessionAgentAvailable(
    conversationKey: string,
    userId: string,
    session: { agentType: AgentType },
  ): AgentType {
    const resolvedAgentType = resolveAvailableAgentType(
      session.agentType,
      config.defaultAgent,
      getRegisteredTypes(),
    );

    if (resolvedAgentType !== session.agentType) {
      logger.warn(
        `Session agent ${session.agentType} unavailable for user=${redactUserId(userId)}; falling back to ${resolvedAgentType}`,
      );
      updateSession(conversationKey, { agentType: resolvedAgentType });
    }

    return resolvedAgentType;
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
