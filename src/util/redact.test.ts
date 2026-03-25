import { describe, expect, it } from "vitest";

import { redactBody } from "./redact.js";

describe("redactBody", () => {
  it("masks sensitive token fields in JSON-like bodies", () => {
    const body = JSON.stringify({
      context_token: "ctx-secret",
      token: "token-secret",
      bot_token: "bot-secret",
      authorization: "Bearer abc",
      Authorization: "Bearer xyz",
      safe: "keep-me",
    });

    const redacted = redactBody(body, 500);

    expect(redacted).toContain('"context_token":"<redacted>"');
    expect(redacted).toContain('"token":"<redacted>"');
    expect(redacted).toContain('"bot_token":"<redacted>"');
    expect(redacted).toContain('"authorization":"<redacted>"');
    expect(redacted).toContain('"Authorization":"<redacted>"');
    expect(redacted).toContain('"safe":"keep-me"');
    expect(redacted).not.toContain("ctx-secret");
    expect(redacted).not.toContain("token-secret");
  });
});
