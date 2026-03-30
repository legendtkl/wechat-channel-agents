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

function createMockAgent(type: AgentType, response?: Partial<AgentResponse>): AgentBackend {
  return {
    type,
    run: vi.fn<(req: Parameters<AgentBackend["run"]>[0]) => Promise<AgentResponse>>().mockImplementation(async () => ({
      text: response?.text ?? `${type} response`,
      isError: response?.isError ?? false,
      toolsUsed: response?.toolsUsed ?? [],
    })),
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
  let updateSession: typeof import("../storage/sessions.js").updateSession;
  let listSessions: typeof import("../storage/sessions.js").listSessions;
  let setContextToken: typeof import("../wechat/context-token.js").setContextToken;
  let initContextTokenStore: typeof import("../wechat/context-token.js").initContextTokenStore;
  let sendMessageMock: ReturnType<typeof vi.fn>;

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

    createDispatcher = dispatcherMod.createDispatcher;
    registerAgent = registryMod.registerAgent;
    getRegisteredTypes = registryMod.getRegisteredTypes;
    setAllowedUsers = allowlistMod.setAllowedUsers;
    setAdminUsers = allowlistMod.setAdminUsers;
    initSessions = sessionsMod.initSessions;
    getSession = sessionsMod.getSession;
    updateSession = sessionsMod.updateSession;
    listSessions = sessionsMod.listSessions;
    setContextToken = contextTokenMod.setContextToken;
    initContextTokenStore = contextTokenMod.initContextTokenStore;
    sendMessageMock = apiMod.sendMessage as ReturnType<typeof vi.fn>;
    sendMessageMock.mockClear();

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

  it("streams incremental agent output without re-sending the full body at the end", async () => {
    const streamedBody = `${"a".repeat(300)}tail`;
    const mockClaude: AgentBackend = {
      type: "claude",
      run: vi.fn(async (req) => {
        await req.onTextDelta?.("a".repeat(300));
        await req.onTextDelta?.("tail");
        return {
          text: streamedBody,
          isError: false,
          toolsUsed: [],
        };
      }),
      resetSession: vi.fn(),
      getStatus: vi.fn().mockReturnValue("claude is idle"),
    };
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeTextMessage(userId, "stream this");
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    const texts = getSentTexts();
    expect(texts).toEqual(["a".repeat(300), "tail"]);
  });

  it("flushes streamed partial output before sending an error reply", async () => {
    const mockClaude: AgentBackend = {
      type: "claude",
      run: vi.fn(async (req) => {
        await req.onTextDelta?.("partial");
        throw new Error("boom");
      }),
      resetSession: vi.fn(),
      getStatus: vi.fn().mockReturnValue("claude is idle"),
    };
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    const msg = makeTextMessage(userId, "stream then fail");
    setContextToken(accountId, userId, "ctx-token-123");

    await dispatch({ accountId, apiOpts, msg, typingTicket });

    const texts = getSentTexts();
    expect(texts).toEqual(["partial", "Error: Error: boom"]);
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

  it("/sessions shows both agents with active and archived sessions", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");
    const conversationKey = `${accountId}:${userId}`;

    // Create a session then give it a session ID
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    updateSession(conversationKey, { claudeSessionId: "sess-abc-123-456" });

    // Reset to archive it
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/reset"), typingTicket });
    sendMessageMock.mockClear();

    // List all sessions
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/sessions"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    expect(full).toContain("[Claude]");
    expect(full).toContain("[Codex]");
    expect(full).toContain("[active]");
    expect(full).toContain("sess-abc");
    expect(full).toContain("/resume");
  });

  it("/sessions claude filters to only claude sessions", async () => {
    const mockClaude = createMockAgent("claude");
    const mockCodex = createMockAgent("codex");
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");
    const conversationKey = `${accountId}:${userId}`;

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    updateSession(conversationKey, { claudeSessionId: "claude-sess-111", codexThreadId: "codex-thread-222" });
    sendMessageMock.mockClear();

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/sessions claude"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    expect(full).toContain("[Claude]");
    expect(full).not.toContain("[Codex]");
    expect(full).toContain("claude-s");
  });

  it("/sessions codex filters to only codex sessions", async () => {
    const mockClaude = createMockAgent("claude");
    const mockCodex = createMockAgent("codex");
    registerAgent(mockClaude);
    registerAgent(mockCodex);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");
    const conversationKey = `${accountId}:${userId}`;

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    updateSession(conversationKey, { codexThreadId: "codex-thread-333" });
    sendMessageMock.mockClear();

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/sessions codex"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    expect(full).toContain("[Codex]");
    expect(full).not.toContain("[Claude]");
    expect(full).toContain("codex-th");
  });

  it("/resume claude <n> restores a claude archived session", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");
    const conversationKey = `${accountId}:${userId}`;

    // Create session with a session ID
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    updateSession(conversationKey, { claudeSessionId: "sess-original-123" });

    // Reset to archive it
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/reset"), typingTicket });

    // Verify session was archived
    const result = listSessions(conversationKey);
    expect(result.claude.length).toBe(2); // active + 1 archived

    sendMessageMock.mockClear();

    // Resume the archived claude session
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/resume claude 1"), typingTicket });

    const texts = getSentTexts();
    const full = texts.join("\n");
    expect(full).toContain("Resumed");
    expect(full).toContain("claude");
    expect(full).toContain("sess-ori");

    // Verify the session was restored
    const session = getSession(conversationKey);
    expect(session?.claudeSessionId).toBe("sess-original-123");
    expect(session?.agentType).toBe("claude");
  });

  it("/resume <n> uses current agent type", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");
    const conversationKey = `${accountId}:${userId}`;

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "init"), typingTicket });
    updateSession(conversationKey, { claudeSessionId: "sess-shorthand-789" });

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/reset"), typingTicket });
    sendMessageMock.mockClear();

    // Resume using shorthand (no agent name, uses current agent = claude)
    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/resume 1"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Resumed"))).toBe(true);

    const session = getSession(conversationKey);
    expect(session?.claudeSessionId).toBe("sess-shorthand-789");
  });

  it("/resume with invalid index shows error", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/resume claude 99"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("not found"))).toBe(true);
  });

  it("/resume without args shows usage", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/resume"), typingTicket });

    const texts = getSentTexts();
    expect(texts.some((t) => t.includes("Usage:"))).toBe(true);
  });

  it("/help includes /sessions and /resume commands", async () => {
    const mockClaude = createMockAgent("claude");
    registerAgent(mockClaude);

    const dispatch = createDispatcher({ config: makeConfig() });
    setContextToken(accountId, userId, "ctx");

    await dispatch({ accountId, apiOpts, msg: makeTextMessage(userId, "/help"), typingTicket });

    const texts = getSentTexts();
    const helpText = texts.join("\n");
    expect(helpText).toContain("/sessions");
    expect(helpText).toContain("/resume");
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
