export type AgentType = "claude" | "codex";

export interface UserSession {
  agentType: AgentType;
  cwd: string;
  lastActive: number;
  claudeSessionId?: string;
  codexThreadId?: string;
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
  maxSessionAge: number;
  textChunkLimit: number;
  logLevel: string;
}
