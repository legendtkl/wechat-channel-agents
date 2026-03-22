import crypto from "node:crypto";

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomUint32(): number {
  return crypto.randomBytes(4).readUInt32BE(0);
}

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${randomHex(4)}`;
}
