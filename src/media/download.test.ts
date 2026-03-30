import { beforeEach, describe, expect, it, vi } from "vitest";

const { cdnDownloadDecryptMock } = vi.hoisted(() => ({
  cdnDownloadDecryptMock: vi.fn(),
}));

vi.mock("../cdn/pic-decrypt.js", () => ({
  cdnDownloadDecrypt: cdnDownloadDecryptMock,
}));

vi.mock("../util/logger.js", () => {
  const noop = () => {};
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

describe("downloadImage", () => {
  beforeEach(() => {
    cdnDownloadDecryptMock.mockReset();
  });

  it("falls back to thumb_media when the primary image media fails", async () => {
    const { downloadImage } = await import("./download.js");

    const thumbBuffer = Buffer.from("thumb");
    cdnDownloadDecryptMock
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValueOnce(thumbBuffer);

    const result = await downloadImage({
      media: {
        encrypt_query_param: "primary",
        aes_key: "primary-key",
      },
      thumb_media: {
        encrypt_query_param: "thumb",
        aes_key: "thumb-key",
      },
    });

    expect(result).toBe(thumbBuffer);
    expect(cdnDownloadDecryptMock).toHaveBeenNthCalledWith(1, "primary", "primary-key");
    expect(cdnDownloadDecryptMock).toHaveBeenNthCalledWith(2, "thumb", "thumb-key");
  });

  it("returns null when image metadata is missing", async () => {
    const { downloadImage } = await import("./download.js");

    const result = await downloadImage({});
    expect(result).toBeNull();
    expect(cdnDownloadDecryptMock).not.toHaveBeenCalled();
  });
});
