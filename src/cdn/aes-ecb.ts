import crypto from "node:crypto";

const ALGORITHM = "aes-128-ecb";

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv(ALGORITHM, key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseAesKey(base64Key: string): Buffer {
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  const hexStr = decoded.toString("ascii");
  return Buffer.from(hexStr, "hex");
}

export function generateAesKey(): Buffer {
  return crypto.randomBytes(16);
}
