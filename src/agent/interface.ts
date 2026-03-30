import type { AgentType } from "../types.js";

export interface AgentImageInput {
  data: Buffer;
  mimeType: string;
}

export interface AgentRequest {
  userId: string;
  prompt: string;
  cwd: string;
  images?: AgentImageInput[];
}

export interface AgentResponse {
  text: string;
  isError: boolean;
  toolsUsed: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentBackend {
  readonly type: AgentType;
  readonly supportsImages?: boolean;
  run(req: AgentRequest): Promise<AgentResponse>;
  resetSession(userId: string): void;
  getStatus(userId: string): string;
}
