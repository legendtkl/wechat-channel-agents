import { logger } from "../util/logger.js";

const contextTokenStore = new Map<string, string>();

export function setContextToken(userId: string, token: string): void {
  logger.debug(`setContextToken: userId=${userId}`);
  contextTokenStore.set(userId, token);
}

export function getContextToken(userId: string): string | undefined {
  const val = contextTokenStore.get(userId);
  logger.debug(`getContextToken: userId=${userId} found=${val !== undefined}`);
  return val;
}
