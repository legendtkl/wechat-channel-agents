import { logger } from "../util/logger.js";

let allowedUsers: Set<string> = new Set();
let adminUsers: Set<string> = new Set();

export function setAllowedUsers(users: string[]): void {
  allowedUsers = new Set(users);
  if (allowedUsers.size > 0) {
    logger.info(`Allowlist configured: ${allowedUsers.size} users`);
  } else {
    logger.info("Allowlist empty, all users allowed");
  }
}

export function setAdminUsers(users: string[]): void {
  adminUsers = new Set(users);
  if (adminUsers.size > 0) {
    logger.info(`Admin list configured: ${adminUsers.size} users`);
  } else {
    logger.warn("Admin list empty, admin commands disabled");
  }
}

export function isUserAllowed(userId: string): boolean {
  if (allowedUsers.size === 0) return true;
  return allowedUsers.has(userId);
}

export function isUserAdmin(userId: string): boolean {
  return adminUsers.has(userId);
}

export function hasAdminUsers(): boolean {
  return adminUsers.size > 0;
}
