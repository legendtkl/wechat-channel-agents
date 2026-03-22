import { buildUploadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";

const MAX_RETRIES = 3;

export async function cdnUpload(
  uploadParam: string,
  filekey: string,
  ciphertext: Buffer,
): Promise<string> {
  const url = buildUploadUrl(uploadParam, filekey);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (!resp.ok) {
        throw new Error(`CDN upload HTTP ${resp.status}`);
      }

      const downloadParam = resp.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("Missing x-encrypted-param in CDN upload response");
      }

      return downloadParam;
    } catch (err) {
      logger.warn(`CDN upload attempt ${attempt} failed: ${String(err)}`);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  throw new Error("CDN upload failed after retries");
}
