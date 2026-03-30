import fs from "node:fs";
import path from "node:path";
import type { AgentType, AgentSessionRecord, UserSession } from "../types.js";
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

  archiveAgentSession(session, agentType);

  if (agentType === "claude") {
    session.claudeSessionId = undefined;
  } else {
    session.codexThreadId = undefined;
  }
  session.lastActive = Date.now();
  saveSessions();
  logger.info(`Reset ${agentType} session for user ${userId}`);
}

const MAX_HISTORY_PER_AGENT = 20;

function getHistory(session: UserSession, agentType: AgentType): AgentSessionRecord[] {
  if (agentType === "claude") {
    if (!session.claudeHistory) session.claudeHistory = [];
    return session.claudeHistory;
  }
  if (!session.codexHistory) session.codexHistory = [];
  return session.codexHistory;
}

function archiveAgentSession(session: UserSession, agentType: AgentType): void {
  const sessionId = agentType === "claude" ? session.claudeSessionId : session.codexThreadId;
  if (!sessionId) return;

  const history = getHistory(session, agentType);
  history.unshift({
    sessionId,
    cwd: session.cwd,
    createdAt: session.lastActive,
    archivedAt: Date.now(),
  });

  if (history.length > MAX_HISTORY_PER_AGENT) {
    history.splice(MAX_HISTORY_PER_AGENT);
  }
}

export interface AgentSessionListEntry {
  index: number;
  sessionId?: string;
  cwd: string;
  project?: string;
  timestamp: number;
  isActive: boolean;
  source: "bot" | "cli";
}

export interface SessionListResult {
  claude: AgentSessionListEntry[];
  codex: AgentSessionListEntry[];
}

export function listSessions(userId: string, externalClaude?: AgentSessionListEntry[], externalCodex?: AgentSessionListEntry[]): SessionListResult {
  const session = sessions.get(userId);
  const result: SessionListResult = { claude: [], codex: [] };
  if (!session) return result;

  // Claude: active
  result.claude.push({
    index: 0,
    sessionId: session.claudeSessionId,
    cwd: session.cwd,
    timestamp: session.lastActive,
    isActive: true,
    source: "bot",
  });
  // Claude: bot history
  if (session.claudeHistory) {
    for (let i = 0; i < session.claudeHistory.length; i++) {
      const h = session.claudeHistory[i];
      result.claude.push({
        index: result.claude.length,
        sessionId: h.sessionId,
        cwd: h.cwd,
        timestamp: h.archivedAt,
        isActive: false,
        source: "bot",
      });
    }
  }
  // Claude: CLI sessions (skip duplicates of active session)
  if (externalClaude) {
    for (const ext of externalClaude) {
      if (ext.sessionId === session.claudeSessionId) continue;
      result.claude.push({ ...ext, index: result.claude.length });
    }
  }

  // Codex: active
  result.codex.push({
    index: 0,
    sessionId: session.codexThreadId,
    cwd: session.cwd,
    timestamp: session.lastActive,
    isActive: true,
    source: "bot",
  });
  // Codex: bot history
  if (session.codexHistory) {
    for (let i = 0; i < session.codexHistory.length; i++) {
      const h = session.codexHistory[i];
      result.codex.push({
        index: result.codex.length,
        sessionId: h.sessionId,
        cwd: h.cwd,
        timestamp: h.archivedAt,
        isActive: false,
        source: "bot",
      });
    }
  }
  // Codex: CLI sessions
  if (externalCodex) {
    for (const ext of externalCodex) {
      if (ext.sessionId === session.codexThreadId) continue;
      result.codex.push({ ...ext, index: result.codex.length });
    }
  }

  return result;
}

export interface ResumeResult {
  agentType: AgentType;
  sessionId: string;
  cwd: string;
}

export function resumeAgentSession(userId: string, agentType: AgentType, historyIndex: number): ResumeResult | null {
  const session = sessions.get(userId);
  if (!session) return null;

  const history = agentType === "claude" ? session.claudeHistory : session.codexHistory;
  if (!history || historyIndex < 0 || historyIndex >= history.length) return null;

  // archiveAgentSession may unshift into history, shifting indices
  const activeSessionId = agentType === "claude" ? session.claudeSessionId : session.codexThreadId;
  archiveAgentSession(session, agentType);
  const adjustedIndex = activeSessionId ? historyIndex + 1 : historyIndex;
  const [restored] = history.splice(adjustedIndex, 1);

  if (agentType === "claude") {
    session.claudeSessionId = restored.sessionId;
  } else {
    session.codexThreadId = restored.sessionId;
  }
  session.agentType = agentType;
  session.lastActive = Date.now();
  saveSessions();

  logger.info(`Resumed ${agentType} session #${historyIndex + 1} for user ${userId}`);
  return { agentType, sessionId: restored.sessionId, cwd: restored.cwd };
}

/**
 * Resume a session by direct session/thread ID (for CLI sessions).
 */
export function resumeBySessionId(userId: string, agentType: AgentType, sessionId: string, cwd: string, defaultAgent: AgentType, defaultCwd: string): ResumeResult {
  const session = getOrCreateSession(userId, defaultAgent, defaultCwd);

  archiveAgentSession(session, agentType);

  if (agentType === "claude") {
    session.claudeSessionId = sessionId;
  } else {
    session.codexThreadId = sessionId;
  }
  session.agentType = agentType;
  session.cwd = cwd;
  session.lastActive = Date.now();
  saveSessions();

  logger.info(`Resumed ${agentType} CLI session ${sessionId.slice(0, 8)}... for user ${userId}`);
  return { agentType, sessionId, cwd };
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
