import { describe, it, expect } from "vitest";
import { chunkText } from "./chunker.js";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const result = chunkText("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  it("splits at newline boundary", () => {
    const text = "line1\nline2\nline3";
    const result = chunkText(text, 10);
    expect(result[0]).toBe("line1");
    expect(result.length).toBeGreaterThan(1);
  });

  it("splits long text without newlines at space", () => {
    const text = "word1 word2 word3 word4 word5";
    const result = chunkText(text, 15);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it("hard cuts when no good split point", () => {
    const text = "abcdefghijklmnop";
    const result = chunkText(text, 5);
    expect(result[0]).toBe("abcde");
    expect(result.length).toBeGreaterThan(1);
  });

  it("handles empty string", () => {
    const result = chunkText("", 100);
    expect(result).toEqual([""]);
  });

  it("preserves all content across chunks", () => {
    const text = "a".repeat(100);
    const chunks = chunkText(text, 30);
    const joined = chunks.join("");
    expect(joined).toBe(text);
  });
});
