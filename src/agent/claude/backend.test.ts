import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

describe("ClaudeBackend", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-backend-"));
    vi.resetModules();
    queryMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits text deltas from partial stream events without duplicating the final assistant message", async () => {
    const stream = (async function* () {
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "sess-123",
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "sess-123",
      };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "sess-123",
      };
      yield {
        type: "result",
        subtype: "success",
        result: "Hello",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u4",
        session_id: "sess-123",
      };
    })();

    queryMock.mockReturnValue(stream);

    const { initSessions } = await import("../../storage/sessions.js");
    const { ClaudeBackend } = await import("./backend.js");

    initSessions(tmpDir);
    const backend = new ClaudeBackend({
      defaultAgent: "claude",
      wechat: { baseUrl: "https://api.test", botType: "3", routeTag: null },
      anthropicBaseUrl: "https://anthropic.test",
      anthropicAuthToken: "sk-test",
      codex: { workingDirectory: "/tmp" },
      stateDir: tmpDir,
      allowedUsers: [],
      adminUsers: [],
      maxSessionAge: 86_400_000,
      textChunkLimit: 4_000,
      logLevel: "INFO",
    });

    const deltas: string[] = [];
    const result = await backend.run({
      userId: "account:user",
      prompt: "hello",
      cwd: "/tmp",
      onTextDelta: async (text) => {
        deltas.push(text);
      },
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.isError).toBe(false);
  });

  it("falls back to assistant text when partial stream events are unavailable", async () => {
    const stream = (async function* () {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
        },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "sess-456",
      };
      yield {
        type: "result",
        subtype: "success",
        result: "Hello",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u2",
        session_id: "sess-456",
      };
    })();

    queryMock.mockReturnValue(stream);

    const { initSessions } = await import("../../storage/sessions.js");
    const { ClaudeBackend } = await import("./backend.js");

    initSessions(tmpDir);
    const backend = new ClaudeBackend({
      defaultAgent: "claude",
      wechat: { baseUrl: "https://api.test", botType: "3", routeTag: null },
      anthropicBaseUrl: "https://anthropic.test",
      anthropicAuthToken: "sk-test",
      codex: { workingDirectory: "/tmp" },
      stateDir: tmpDir,
      allowedUsers: [],
      adminUsers: [],
      maxSessionAge: 86_400_000,
      textChunkLimit: 4_000,
      logLevel: "INFO",
    });

    const deltas: string[] = [];
    const result = await backend.run({
      userId: "account:user",
      prompt: "hello",
      cwd: "/tmp",
      onTextDelta: async (text) => {
        deltas.push(text);
      },
    });

    expect(deltas).toEqual(["Hello"]);
    expect(result.text).toBe("Hello");
    expect(result.isError).toBe(false);
  });
});
