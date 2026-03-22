import { logger } from "../util/logger.js";

let allowedUsers: Set<string> = new Set();

export function setAllowedUsers(users: string[]): void {
  allowedUsers = new Set(users);
  if (allowedUsers.size > 0) {
    logger.info(`Allowlist configured: ${allowedUsers.size} users`);
  } else {
    logger.info("Allowlist empty, all users allowed");
  }
}

export function isUserAllowed(userId: string): boolean {
  if (allowedUsers.size === 0) return true;
  return allowedUsers.has(userId);
}
