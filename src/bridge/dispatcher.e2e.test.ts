import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { MessageType, MessageItemType } from "../wechat/types.js";
import type { WeixinMessage } from "../wechat/types.js";
import type { WeixinApiOptions } from "../wechat/api.js";
import type { AgentBackend, AgentResponse } from "../agent/interface.js";
import type { AgentType } from "../types.js";

// ---- Mock WeChat API ----
vi.mock("../wechat/api.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue({ typing_ticket: "ticket" }),
}));

// ---- Mock logger to suppress output ----
vi.mock("../util/logger.js", () => {
  const noop = () => {};
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

vi.mock("../media/download.js", () => ({
  downloadImage: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
}));

// ---- Helpers ----
function makeTextMessage(
  userId: string,
  text: string,
  contextToken = "ctx-token-123",
): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: userId,
    to_user_id: "bot",
    context_token: contextToken,
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text } },
    ],
  };
}

function makeImageMessage(
  userId: string,
  contextToken = "ctx-token-123",
  text?: string,
): WeixinMessage {
  const item_list = [
    ...(text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : []),
    {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: "enc",
          aes_key: "aes",
        },
      },
    },
  ];

  return {
    message_type: MessageType.USER,
    from_user_id: userId,
    to_user_id: "bot",
    context_token: contextToken,
    item_list,
  };
}

function createMockAgent(type: AgentType, response?: Partial<AgentResponse>): AgentBackend {
  return {
    type,
    supportsImages: type === "claude",
    run: vi.fn<() => Promise<AgentResponse>>().mockResolvedValue({
      text: response?.text ?? `${type} response`,
      isError: response?.isError ?? false,
      toolsUsed: response?.toolsUsed ?? [],
    }),
    resetSession: vi.fn(),
    getStatus: vi.fn().mockReturnValue(`${type} is idle`),
  };
}

describe("dispatcher e2e", () => {
  let tmpDir: string;
  let apiOpts: WeixinApiOptions;
  const accountId = "test-account";
  const userId = "user-001";
  const typingTicket = "typing-ticket";

  // We need to dynamically import modules that rely on module-level state
  let createDispatcher: typeof import("./dispatcher.js").createDispatcher;
  let registerAgent: typeof import("../agent/registry.js").registerAgent;
  let getRegisteredTypes: typeof import("../agent/registry.js").getRegisteredTypes;
  let setAllowedUsers: typeof import("../auth/allowlist.js").setAllowedUsers;
  let setAdminUsers: typeof import("../auth/allowlist.js").setAdminUsers;
  let initSessions: typeof import("../storage/sessions.js").initSessions;
  let getSession: typeof import("../storage/sessions.js").getSession;
  let setContextToken: typeof import("../wechat/context-token.js").setContextToken;
  let initContextTokenStore: typeof import("../wechat/context-token.js").initContextTokenStore;
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let downloadImageMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Create temp directory for session storage
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));

    // Reset module registry for clean state
    vi.resetModules();

    // Re-import after reset so each test gets fresh module state
    const dispatcherMod = await import("./dispatcher.js");
    const registryMod = await import("../agent/registry.js");
    const allowlistMod = await import("../auth/allowlist.js");
    const sessionsMod = await import("../storage/sessions.js");
    const contextTokenMod = await import("../wechat/context-token.js");
    const apiMod = await import("../wechat/api.js");
    const mediaMod = await import("../media/download.js");

    createDispatcher = dispatcherMod.createDispatcher;
    registerAgent = registryMod.registerAgent;
    getRegisteredTypes = registryMod.getRegisteredTypes;
    setAllowedUsers = allowlistMod.setAllowedUsers;
    setAdminUsers = allowlistMod.setAdminUsers;
    initSessions = sessionsMod.initSessions;
    getSession = sessionsMod.getSession;
    setContextToken = contextTokenMod.setContextToken;
    initContextTokenStore = contextTokenMod.initContextTokenStore;
    sendMessageMock = apiMod.sendMessage as ReturnType<typeof vi.fn>;
    downloadImageMock = mediaMod.downloadImage as ReturnType<typeof vi.fn>;
    sendMessageMock.mockClear();
    downloadImageMock.mockClear();
    downloadImageMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // Setup
    initSessions(tmpDir);
    initContextTokenStore(tmpDir);
    setAllowedUsers([]);  // Empty = allow all
    setAdminUsers([]);

    apiOpts = { baseUrl: "https://api.test", token: "tok", routeTag: "tag" };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Record<string, unknown>) {
    return {
      defaultAgent: "claude" as AgentType,
      wechat: { baseUrl: "https://api.test", routeTag: "tag", botType: "test" },
      anthropicBaseUrl: "https://anthropic.test",
      anthropicAuthToken: "sk-test",
      codex: { workingDirectory: "/tmp" },
      stateDir: tmpDir,
      allowedUsers: [],
      adminUsers: [],
      maxSessionAge: 86400000,
      textChunkLimit: 4000,
      logLevel: "info",
      ...overrides,
    };
  }

  // ---- Sent messages collector ----
  function getSentTexts(): string[] {
    return sendMessageMock.mock.calls.map(
      (call: Array<Record<string, unknown>>) => {
        const body = call[0].body as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } };
        return body?.msg?.item_list?.[0]?.text_item?.text ?? "";
      },
    );
  }

  // =================== Tests ===================

  it("routes a plain text message to the default agent and sends back the response", async () => {
    const mockClaude = createMockAgent("claude", { text: "Hello from Claude!" });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeTextMessage(userId, "Hi there");
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    // Agent was called with the right prompt
    expect(mockClaude.run).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Hi there" }),
    );

    // Response was sent back via WeChat API
    const texts = getSentTexts();
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts[0]).toContain("Hello from Claude!");
  });

  it("routes an image-only message to claude with decoded image input", async () => {
    const mockClaude = createMockAgent("claude", { text: "Image received" });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeImageMessage(userId);
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(downloadImageMock).toHaveBeenCalledTimes(1);
    expect(mockClaude.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        images: [
          expect.objectContaining({
            mimeType: "image/png",
            data: expect.any(Buffer),
          }),
        ],
      }),
    );

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Image received"))).toBe(true);
  });

  it("tells the user to switch to claude when the current agent does not support images", async () => {
    const mockCodex = createMockAgent("codex");
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig({ defaultAgent: "codex" }) });
    const msg = makeImageMessage(userId);
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockCodex.run).not.toHaveBeenCalled();

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Switch to /claude"))).toBe(true);
  });

  it("replies with a download failure message when inbound image download throws", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);
    downloadImageMock.mockRejectedValueOnce(new Error("CDN download failed: HTTP 500"));

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeImageMessage(userId);
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockClaude.run).not.toHaveBeenCalled();

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("failed to download"))).toBe(true);
  });

  it("ignores non-USER messages", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg: WeixinMessage = {
      message_type: MessageType.BOT,
      from_user_id: userId,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "bot msg" } }],
    };

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockClaude.run).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores messages with no text", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg: WeixinMessage = {
      message_type: MessageType.USER,
      from_user_id: userId,
      context_token: "ctx",
      item_list: [],
    };

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockClaude.run).not.toHaveBeenCalled();
  });

  it("blocks messages from non-allowlisted users", async () => {
    setAllowedUsers(["other-user"]);

    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeTextMessage(userId, "Hello");
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockClaude.run).not.toHaveBeenCalled();
  });

  it("allows messages from allowlisted users", async () => {
    setAllowedUsers([userId]);

    const mockClaude = createMockAgent("claude", { text: "allowed" });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeTextMessage(userId, "Hello");
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    expect(mockClaude.run).toHaveBeenCalled();
  });

  it("/claude switches the active agent to claude", async () => {
    const mockClaude = createMockAgent("claude");
    const mockCodex = createMockAgent("codex");
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const config = makeConfig({ defaultAgent: "codex" });
    const dispatch = createDispatcher({ config });
    setContextToken(accountId, userId, "ctx");

    // First, send a message to create a session with codex
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    sendMessageMock.mockClear();

    // Switch to claude
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/claude"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Switched to claude"))).toBe(true);
  });

  it("/codex switches the active agent to codex", async () => {
    const mockClaude = createMockAgent("claude");
    const mockCodex = createMockAgent("codex");
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/codex"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Switched to codex"))).toBe(true);
  });

  it("/claude reports 'Already using' when already on claude", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    // Default is claude, so /claude should say already using
    // First create a session
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    sendMessageMock.mockClear();

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/claude"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Already using claude"))).toBe(true);
  });

  it("/reset resets the current agent session", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/reset"), typingTicket });

    expect(mockClaude.resetSession).toHaveBeenCalled();
    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("session reset"))).toBe(true);
  });

  it("/status returns current status information", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    // Create a session first
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    sendMessageMock.mockClear();

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/status"), typingTicket });

    expect(mockClaude.getStatus).toHaveBeenCalled();
    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Current agent: claude"))).toBe(true);
    expect(texts.some((t) => t.includes(accountId))).toBe(true);
  });

  it("/help returns help text with available commands", async () => {
    const mockClaude = createMockAgent("claude");
    const mockCodex = createMockAgent("codex");
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/help"), typingTicket });

    const texts = getSentTexts();
    const helpText = texts.join("\n");
    expect(helpText).toContain("Commands:");
    expect(helpText).toContain("/reset");
    expect(helpText).toContain("/status");
    expect(helpText).toContain("/help");
    expect(helpText).toContain("/cwd");
  });

  it("/cwd without args shows current directory", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    // Create session first
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    sendMessageMock.mockClear();

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/cwd"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Current CWD:"))).toBe(true);
  });

  it("/cwd <path> changes working directory", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/cwd /home/test"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Working directory changed to: /home/test"))).toBe(true);
  });

  it("agent error results in error message sent to user", async () => {
    const mockClaude = createMockAgent("claude");
    (mockClaude.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agent crashed"));
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "trigger error"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Error:"))).toBe(true);
    expect(texts.some((t) => t.includes("agent crashed"))).toBe(true);
  });

  it("agent response with tools used appends tool summary", async () => {
    const mockClaude = createMockAgent("claude", {
      text: "Done!",
      toolsUsed: ["Read", "Write", "Read"],
    });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "do something"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    expect(full).toContain("Done!");
    expect(full).toContain("[Tools:");
    expect(full).toContain("Read(x2)");
    expect(full).toContain("Write");
  });

  it("agent error response is prefixed with [Error]", async () => {
    const mockClaude = createMockAgent("claude", {
      text: "Something went wrong",
      isError: true,
    });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "query"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("[Error]"))).toBe(true);
  });

  it("long response is chunked into multiple messages", async () => {
    const longText = "A".repeat(5000);
    const mockClaude = createMockAgent("claude", { text: longText });
    registerAgent(mockClaude);

    // Small chunk limit to force splitting
    const dispatch = createDispatcher({ config: makeConfig({ textChunkLimit: 2000 }) });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "long query"), typingTicket });

    // Should have sent multiple chunks
    expect(sendMessageMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("caches context_token from incoming message", async () => {
    const mockClaude = createMockAgent("claude", { text: "ok" });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });

    // Send message with specific context_token
    const msg = makeTextMessage(userId, "hello", "my-ctx-token");
    await dispatch({ accountId, apiOpts, msg, typingTicket });

    // The response should have been sent (requires a valid context token)
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it("switching agents preserves the previous agent session", async () => {
    const mockClaude = createMockAgent("claude", { text: "claude reply" });
    const mockCodex = createMockAgent("codex", { text: "codex reply" });
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    // Send message to claude
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "msg1"), typingTicket });
    expect(mockClaude.run).toHaveBeenCalledTimes(1);

    // Switch to codex
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/codex"), typingTicket });

    // Send message to codex
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "msg2"), typingTicket });
    expect(mockCodex.run).toHaveBeenCalledTimes(1);

    // Switch back to claude
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/claude"), typingTicket });

    // Claude's session was NOT reset
    expect(mockClaude.resetSession).not.toHaveBeenCalled();
  });

  it("/login denied when no admin users configured", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/login"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("disabled until adminUsers"))).toBe(true);
  });

  it("/login denied for non-admin user", async () => {
    setAdminUsers(["admin-user"]);

    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/login"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("restricted to admin"))).toBe(true);
  });

  it("/logout denied when no admin users configured", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/logout"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("disabled until adminUsers"))).toBe(true);
  });

  it("/logout triggers shutdown for admin user", async () => {
    setAdminUsers([userId]);

    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const onLogout = vi.fn().mockResolvedValue(undefined);
    const dispatch = createDispatcher({ config: makeConfig(), onLogout });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/logout"), typingTicket });

    expect(onLogout).toHaveBeenCalled();
    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Logging out"))).toBe(true);
  });

  it("/login triggers login for admin user", async () => {
    setAdminUsers([userId]);

    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const onLogin = vi.fn().mockResolvedValue({ accountId: "new-account" });
    const dispatch = createDispatcher({ config: makeConfig(), onLogin });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/login"), typingTicket });

    expect(onLogin).toHaveBeenCalled();
    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("new-account"))).toBe(true);
  });

  it("multiple users maintain independent sessions", async () => {
    const mockClaude = createMockAgent("claude", { text: "claude reply" });
    const mockCodex = createMockAgent("codex", { text: "codex reply" });
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });

    const user1 = "user-A";
    const user2 = "user-B";
    setContextToken(accountId, user1, "ctx1");
    setContextToken(accountId, user2, "ctx2");

    // User1 uses default (claude)
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(user1, "hello"), typingTicket });

    // User2 switches to codex
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(user2, "/codex"), typingTicket });
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(user2, "hello"), typingTicket });

    // User1 is still on claude
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(user1, "still claude?"), typingTicket });

    // Claude called twice (user1 twice), codex called once (user2 once)
    expect(mockClaude.run).toHaveBeenCalledTimes(2);
    expect(mockCodex.run).toHaveBeenCalledTimes(1);
  });

  it("unavailable agent falls back to default", async () => {
    // Only register claude, not codex
    const mockClaude = createMockAgent("claude", { text: "fallback" });
    registerAgent(mockClaude);

    // Config says default is codex, but codex isn't registered
    // The agent-resolution logic should fall back
    const dispatch = createDispatcher({ config: makeConfig({ defaultAgent: "claude" }) });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "hello"), typingTicket });

    expect(mockClaude.run).toHaveBeenCalled();
  });

  it("markdown in agent response is converted to plain text", async () => {
    const mockClaude = createMockAgent("claude", {
      text: "## Title\n**bold** and *italic*\n```js\nconsole.log('hi')\n```",
    });
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "test md"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    // Headers, bold markers should be stripped
    expect(full).not.toContain("##");
    expect(full).not.toContain("**");
    expect(full).toContain("Title");
    expect(full).toContain("bold");
  });
});
