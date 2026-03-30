import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createStreamingSender } from "./streaming-sender.js";

describe("createStreamingSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes after the configured delay", async () => {
    const send = vi.fn<(_text: string) => Promise<void>>().mockResolvedValue(undefined);
    const sender = createStreamingSender({
      send,
      flushIntervalMs: 2_000,
      flushChars: 300,
      maxChunkLen: 4_000,
    });

    await sender.push("hello");
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, "hello");
  });

  it("flushes immediately when the pending buffer reaches the size threshold", async () => {
    const send = vi.fn<(_text: string) => Promise<void>>().mockResolvedValue(undefined);
    const sender = createStreamingSender({
      send,
      flushIntervalMs: 2_000,
      flushChars: 300,
      maxChunkLen: 4_000,
    });

    await sender.push("a".repeat(300));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, "a".repeat(300));
  });

  it("flushes the remaining buffer and then sends the final tail", async () => {
    const send = vi.fn<(_text: string) => Promise<void>>().mockResolvedValue(undefined);
    const sender = createStreamingSender({
      send,
      flushIntervalMs: 2_000,
      flushChars: 300,
      maxChunkLen: 4_000,
    });

    await sender.push("partial");
    await sender.finish("[Tools: Bash]");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "partial");
    expect(send).toHaveBeenNthCalledWith(2, "[Tools: Bash]");
  });

  it("splits oversized payloads with chunkText rules", async () => {
    const send = vi.fn<(_text: string) => Promise<void>>().mockResolvedValue(undefined);
    const sender = createStreamingSender({
      send,
      flushIntervalMs: 2_000,
      flushChars: 5,
      maxChunkLen: 5,
    });

    await sender.push("hello\nworld");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "hello");
    expect(send).toHaveBeenNthCalledWith(2, "world");
  });
});
