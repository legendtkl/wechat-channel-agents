import type { WeixinMessage } from "../wechat/types.js";
import { MessageType, MessageItemType, TypingStatus } from "../wechat/types.js";
import { sendTyping } from "../wechat/api.js";
import type { WeixinApiOptions } from "../wechat/api.js";
import { sendTextMessage, markdownToPlainText } from "../wechat/send.js";
import { setContextToken, getContextToken } from "../wechat/context-token.js";
import { getAgent, getRegisteredTypes } from "../agent/registry.js";
import { getOrCreateSession, updateSession, resetAgentSession } from "../storage/sessions.js";
import { hasAdminUsers, isUserAdmin, isUserAllowed } from "../auth/allowlist.js";
import { resolveAvailableAgentType } from "./agent-resolution.js";
import { formatResponse } from "./formatter.js";
import { chunkText } from "./chunker.js";
import { logger } from "../util/logger.js";
import { redactUserId } from "../util/redact.js";
import { buildConversationKey, type AgentType, type AppConfig } from "../types.js";

const TYPING_INTERVAL_MS = 10_000;

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
    } else {
      logger.warn(`No context_token in message from user=${redactUserId(userId)} — will reuse last known token`);
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

    // Start typing indicator
    const typingController = new AbortController();
    startTypingLoop(apiOpts, userId, typingTicket, typingController.signal);

    try {
      const agent = getAgent(agentType);
      const result = await agent.run({
        userId: conversationKey,
        prompt: trimmed,
        cwd: session.cwd,
      });

      typingController.abort();

      const response = formatResponse(result.text, result.toolsUsed, result.isError);
      const plainText = markdownToPlainText(response);
      const chunks = chunkText(plainText, config.textChunkLimit);

      await sendChunks(accountId, apiOpts, userId, chunks);
    } catch (err) {
      typingController.abort();
      logger.error(`Agent error for user=${redactUserId(userId)}: ${String(err)}`);
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
    const contextToken = getContextToken(accountId, userId);
    for (const chunk of chunks) {
      try {
        await sendTextMessage({
          to: userId,
          text: chunk,
          opts: { ...apiOpts, contextToken },
        });
      } catch (err) {
        logger.error(`Failed to send chunk accountId=${accountId} to=${redactUserId(userId)}: ${String(err)}`);
      }
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
