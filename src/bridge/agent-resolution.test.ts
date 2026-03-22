import { describe, expect, it } from "vitest";
import { resolveAvailableAgentType } from "./agent-resolution.js";

describe("resolveAvailableAgentType", () => {
  it("keeps the current agent when it is registered", () => {
    expect(resolveAvailableAgentType("codex", "codex", ["codex"])).toBe("codex");
  });

  it("falls back to the configured default agent when the current one is unavailable", () => {
    expect(resolveAvailableAgentType("claude", "codex", ["codex"])).toBe("codex");
  });

  it("falls back to the first registered agent when the default is unavailable", () => {
    expect(resolveAvailableAgentType("claude", "codex", ["claude"])).toBe("claude");
  });

  it("throws when no backends are registered", () => {
    expect(() => resolveAvailableAgentType("claude", "codex", [])).toThrow("No agent backends registered");
  });
});
