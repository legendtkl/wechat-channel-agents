import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const startThreadMock = vi.fn();

vi.mock("@openai/codex-sdk", () => {
  class Codex {
    startThread = startThreadMock;
    resumeThread = vi.fn();
  }

  return { Codex };
});

describe("CodexBackend", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-backend-"));
    vi.resetModules();
    startThreadMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits only the unseen suffix for repeated agent_message updates", async () => {
    const events = (async function* () {
      yield {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hel" },
      };
      yield {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hello" },
      };
      yield {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Hello world" },
      };
      yield {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      };
    })();

    startThreadMock.mockReturnValue({
      id: "thread-123",
      runStreamed: vi.fn().mockResolvedValue({ events }),
    });

    const { initSessions } = await import("../../storage/sessions.js");
    const { CodexBackend } = await import("./backend.js");

    initSessions(tmpDir);
    const backend = new CodexBackend({
      defaultAgent: "codex",
      wechat: { baseUrl: "https://api.test", botType: "3", routeTag: null },
      anthropicBaseUrl: "",
      anthropicAuthToken: "",
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

    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(result.text).toBe("Hello world");
    expect(result.isError).toBe(false);
  });
});
