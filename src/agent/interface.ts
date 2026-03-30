import type { AgentType } from "../types.js";

export interface AgentRequest {
  userId: string;
  prompt: string;
  cwd: string;
  onTextDelta?: (text: string) => Promise<void> | void;
}

export interface AgentResponse {
  text: string;
  isError: boolean;
  toolsUsed: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentBackend {
  readonly type: AgentType;
  run(req: AgentRequest): Promise<AgentResponse>;
  resetSession(userId: string): void;
  getStatus(userId: string): string;
}
