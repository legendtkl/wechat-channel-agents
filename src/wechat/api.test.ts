import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessage } from "./api.js";

describe("wechat api sendMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when sendmessage returns a business error in a 200 response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ret: -1, errmsg: "invalid context token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      sendMessage({
        baseUrl: "https://api.test",
        token: "token",
        body: {
          msg: {
            to_user_id: "user-1",
            context_token: "ctx-1",
          },
        },
      }),
    ).rejects.toThrow("sendMessage failed: ret=-1 errmsg=invalid context token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts successful sendmessage responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ret: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      sendMessage({
        baseUrl: "https://api.test",
        token: "token",
        body: {
          msg: {
            to_user_id: "user-1",
            context_token: "ctx-1",
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
