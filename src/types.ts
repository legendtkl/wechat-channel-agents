export type AgentType = "claude" | "codex";

export interface AgentSessionRecord {
  sessionId: string;
  cwd: string;
  createdAt: number;
  archivedAt: number;
}

export interface UserSession {
  agentType: AgentType;
  cwd: string;
  lastActive: number;
  claudeSessionId?: string;
  codexThreadId?: string;
  claudeHistory?: AgentSessionRecord[];
  codexHistory?: AgentSessionRecord[];
}

export interface AppConfig {
  defaultAgent: AgentType;
  wechat: {
    baseUrl: string;
    routeTag?: string | null;
    botType: string;
  };
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  codex: {
    model?: string;
    sandboxMode?: string;
    workingDirectory: string;
  };
  stateDir: string;
  allowedUsers: string[];
  adminUsers: string[];
  maxSessionAge: number;
  textChunkLimit: number;
  logLevel: string;
}

export function buildConversationKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}
