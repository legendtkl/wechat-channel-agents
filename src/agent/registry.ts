import type { AgentType } from "../types.js";
import type { AgentBackend } from "./interface.js";

const backends = new Map<AgentType, AgentBackend>();

export function registerAgent(backend: AgentBackend): void {
  backends.set(backend.type, backend);
}

export function getAgent(type: AgentType): AgentBackend {
  const backend = backends.get(type);
  if (!backend) {
    throw new Error(`No agent backend registered for type: ${type}`);
  }
  return backend;
}

export function getRegisteredTypes(): AgentType[] {
  return [...backends.keys()];
}
