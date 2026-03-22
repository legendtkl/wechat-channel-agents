import fs from "node:fs";
import path from "node:path";
import type { AgentType, UserSession } from "../types.js";
import { logger } from "../util/logger.js";

const sessions = new Map<string, UserSession>();
let sessionsFilePath: string | null = null;

export function initSessions(stateDir: string): void {
  const dir = path.join(stateDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  sessionsFilePath = path.join(dir, "sessions.json");
  loadSessions();
}

function loadSessions(): void {
  if (!sessionsFilePath) return;
  try {
    if (fs.existsSync(sessionsFilePath)) {
      const data = JSON.parse(fs.readFileSync(sessionsFilePath, "utf-8")) as Record<string, UserSession>;
      for (const [userId, entry] of Object.entries(data)) {
        sessions.set(userId, entry);
      }
      logger.info(`Loaded ${sessions.size} sessions`);
    }
  } catch (err) {
    logger.warn(`Failed to load sessions: ${String(err)}`);
  }
}

function saveSessions(): void {
  if (!sessionsFilePath) return;
  const data: Record<string, UserSession> = {};
  for (const [userId, entry] of sessions) {
    data[userId] = entry;
  }
  fs.writeFileSync(sessionsFilePath, JSON.stringify(data, null, 2));
}

export function getSession(userId: string): UserSession | undefined {
  return sessions.get(userId);
}

export function getOrCreateSession(userId: string, defaultAgent: AgentType, defaultCwd: string): UserSession {
  let session = sessions.get(userId);
  if (!session) {
    session = {
      agentType: defaultAgent,
      cwd: defaultCwd,
      lastActive: Date.now(),
    };
    sessions.set(userId, session);
    saveSessions();
  }
  return session;
}

export function updateSession(userId: string, updates: Partial<UserSession>): void {
  const session = sessions.get(userId);
  if (session) {
    Object.assign(session, updates, { lastActive: Date.now() });
    saveSessions();
  }
}

export function touchSession(userId: string): void {
  const session = sessions.get(userId);
  if (session) {
    session.lastActive = Date.now();
    saveSessions();
  }
}

export function resetAgentSession(userId: string, agentType: AgentType): void {
  const session = sessions.get(userId);
  if (!session) return;

  if (agentType === "claude") {
    session.claudeSessionId = undefined;
  } else {
    session.codexThreadId = undefined;
  }
  session.lastActive = Date.now();
  saveSessions();
  logger.info(`Reset ${agentType} session for user ${userId}`);
}

export function deleteSession(userId: string): void {
  sessions.delete(userId);
  saveSessions();
  logger.info(`Session deleted for user ${userId}`);
}

export function cleanupSessions(maxAge: number): number {
  const now = Date.now();
  let removed = 0;
  for (const [userId, entry] of sessions) {
    if (now - entry.lastActive > maxAge) {
      sessions.delete(userId);
      removed++;
    }
  }
  if (removed > 0) {
    saveSessions();
    logger.info(`Cleaned up ${removed} expired sessions`);
  }
  return removed;
}
