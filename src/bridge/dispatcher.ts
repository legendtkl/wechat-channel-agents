import type { AgentImageInput } from "../agent/interface.js";
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
import { downloadImage } from "../media/download.js";
import { detectImageMimeType } from "../media/mime.js";
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
    }

    // Allowlist check
    if (!isUserAllowed(userId)) {
      logger.warn(`User not in allowlist: ${redactUserId(userId)}`);
      return;
    }

    const input = await extractAgentInput(msg);
    if (!input.prompt && input.images.length === 0) {
      if (input.imageCount > 0 && input.failedImageCount === input.imageCount) {
        await sendReply(
          accountId,
          apiOpts,
          userId,
          "Received the image, but failed to download it from WeChat.",
        );
      }
      return;
    }

    logger.info(
      `Message from=${redactUserId(userId)} len=${input.prompt.length} images=${input.images.length}`,
    );

    // Parse commands
    const trimmed = input.prompt.trim();
    const firstWord = trimmed ? trimmed.split(/\s/)[0].toLowerCase() : "";

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
    const agent = getAgent(agentType);

    if (input.images.length > 0 && agent.supportsImages !== true) {
      await sendReply(
        accountId,
        apiOpts,
        userId,
        `${agentType} does not support image input in this bridge yet. Switch to /claude to analyze images.`,
      );
      return;
    }

    // Start typing indicator
    const typingController = new AbortController();
    startTypingLoop(apiOpts, userId, typingTicket, typingController.signal);

    try {
      const result = await agent.run({
        userId: conversationKey,
        prompt: trimmed,
        cwd: session.cwd,
        images: input.images,
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

interface ExtractedAgentInput {
  prompt: string;
  images: AgentImageInput[];
  imageCount: number;
  failedImageCount: number;
}

async function extractAgentInput(msg: WeixinMessage): Promise<ExtractedAgentInput> {
  const textParts: string[] = [];
  const images: AgentImageInput[] = [];
  let imageCount = 0;
  let failedImageCount = 0;

  if (!msg.item_list?.length) {
    return { prompt: "", images, imageCount, failedImageCount };
  }

  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      textParts.push(item.text_item.text);
      continue;
    }

    if (item.type === MessageItemType.IMAGE) {
      imageCount += 1;

      if (!item.image_item) {
        failedImageCount += 1;
        continue;
      }

      logger.info(
        `Inbound image metadata: media=${Boolean(item.image_item.media?.encrypt_query_param)} thumb_media=${Boolean(item.image_item.thumb_media?.encrypt_query_param)} url=${Boolean(item.image_item.url)} aeskey=${Boolean(item.image_item.aeskey)} mid_size=${item.image_item.mid_size ?? 0} thumb_size=${item.image_item.thumb_size ?? 0} hd_size=${item.image_item.hd_size ?? 0}`,
      );

      let data: Buffer | null;
      try {
        data = await downloadImage(item.image_item);
      } catch (err) {
        failedImageCount += 1;
        logger.error(`Failed to download inbound WeChat image: ${String(err)}`);
        continue;
      }

      if (!data) {
        failedImageCount += 1;
        continue;
      }

      const mimeType = detectImageMimeType(data);
      if (!mimeType) {
        failedImageCount += 1;
        logger.warn("Inbound WeChat image has an unsupported MIME type");
        continue;
      }

      images.push({ data, mimeType });
    }
  }

  return {
    prompt: textParts.join("\n"),
    images,
    imageCount,
    failedImageCount,
  };
}
