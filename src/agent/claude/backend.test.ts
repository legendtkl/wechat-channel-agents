import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initSessions } from "../../storage/sessions.js";
import type { AppConfig } from "../../types.js";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../../util/logger.js", () => {
  const noop = () => {};
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

function makeConfig(stateDir: string): AppConfig {
  return {
    defaultAgent: "claude",
    wechat: { baseUrl: "https://api.test", routeTag: "tag", botType: "test" },
    anthropicBaseUrl: "https://anthropic.test",
    anthropicAuthToken: "sk-test",
    codex: { workingDirectory: "/tmp" },
    stateDir,
    allowedUsers: [],
    adminUsers: [],
    maxSessionAge: 86_400_000,
    textChunkLimit: 4000,
    logLevel: "info",
  };
}

async function* makeClaudeStream() {
  yield {
    type: "assistant",
    session_id: "session-123",
    message: {
      content: [{ type: "text", text: "assistant reply" }],
    },
  };

  yield {
    type: "result",
    session_id: "session-123",
    subtype: "success",
    result: "final reply",
    is_error: false,
  };
}

describe("ClaudeBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-backend-"));
    initSessions(tmpDir);
    queryMock.mockReset();
    queryMock.mockImplementation(() => makeClaudeStream());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends plain text requests as a string prompt", async () => {
    const { ClaudeBackend } = await import("./backend.js");
    const backend = new ClaudeBackend(makeConfig(tmpDir));

    await backend.run({
      userId: "user-1",
      prompt: "hello claude",
      cwd: "/tmp",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].prompt).toBe("hello claude");
  });

  it("sends image requests as multimodal SDK user messages", async () => {
    const { ClaudeBackend } = await import("./backend.js");
    const backend = new ClaudeBackend(makeConfig(tmpDir));
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await backend.run({
      userId: "user-2",
      prompt: "",
      cwd: "/tmp",
      images: [{ data: imageData, mimeType: "image/png" }],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);

    const multimodalPrompt = queryMock.mock.calls[0][0].prompt as AsyncIterable<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(typeof multimodalPrompt).not.toBe("string");

    const iterator = multimodalPrompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toEqual([
      { type: "text", text: "Please analyze the attached image." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData.toString("base64"),
        },
      },
    ]);
  });
});
