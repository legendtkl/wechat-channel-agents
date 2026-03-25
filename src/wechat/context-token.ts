import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";

const contextTokenStore = new Map<string, string>();
let contextTokenFilePath: string | null = null;

function persistContextTokens(): void {
  if (!contextTokenFilePath) return;
  try {
    fs.mkdirSync(path.dirname(contextTokenFilePath), { recursive: true });
    fs.writeFileSync(
      contextTokenFilePath,
      JSON.stringify(Object.fromEntries(contextTokenStore), null, 2),
      "utf-8",
    );
  } catch (err) {
    logger.warn(`persistContextTokens: failed to write ${contextTokenFilePath}: ${String(err)}`);
  }
}

export function initContextTokenStore(stateDir: string): void {
  contextTokenStore.clear();
  contextTokenFilePath = path.join(stateDir, "context-tokens.json");

  try {
    if (!fs.existsSync(contextTokenFilePath)) {
      logger.info("initContextTokenStore: no persisted context tokens found");
      return;
    }

    const raw = fs.readFileSync(contextTokenFilePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    for (const [userId, token] of Object.entries(parsed)) {
      if (typeof token === "string" && token) {
        contextTokenStore.set(userId, token);
      }
    }

    logger.info(`initContextTokenStore: restored ${contextTokenStore.size} context tokens`);
  } catch (err) {
    logger.warn(`initContextTokenStore: failed to load persisted tokens: ${String(err)}`);
  }
}

export function setContextToken(userId: string, token: string): void {
  logger.debug(`setContextToken: userId=${userId}`);
  contextTokenStore.set(userId, token);
  persistContextTokens();
}

export function getContextToken(userId: string): string | undefined {
  const val = contextTokenStore.get(userId);
  logger.debug(`getContextToken: userId=${userId} found=${val !== undefined}`);
  return val;
}

export function clearContextTokens(): void {
  contextTokenStore.clear();

  if (!contextTokenFilePath) return;

  try {
    if (fs.existsSync(contextTokenFilePath)) {
      fs.unlinkSync(contextTokenFilePath);
    }
  } catch (err) {
    logger.warn(`clearContextTokens: failed to remove ${contextTokenFilePath}: ${String(err)}`);
  }
}
