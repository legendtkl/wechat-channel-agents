import { buildDownloadUrl } from "./cdn-url.js";
import { aesEcbDecrypt, parseAesKey } from "./aes-ecb.js";
import { logger } from "../util/logger.js";

export async function cdnDownloadDecrypt(
  encryptedQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildDownloadUrl(encryptedQueryParam);
  logger.debug(`Downloading from CDN: ${url.slice(0, 80)}...`);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CDN download failed: HTTP ${resp.status}`);
  }

  const ciphertext = Buffer.from(await resp.arrayBuffer());
  const key = parseAesKey(aesKeyBase64);
  return aesEcbDecrypt(ciphertext, key);
}
