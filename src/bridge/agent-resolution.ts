import type { AgentType } from "../types.js";

export function resolveAvailableAgentType(
  currentAgentType: AgentType,
  defaultAgent: AgentType,
  registeredTypes: AgentType[],
): AgentType {
  if (registeredTypes.includes(currentAgentType)) {
    return currentAgentType;
  }

  if (registeredTypes.includes(defaultAgent)) {
    return defaultAgent;
  }

  const fallbackAgent = registeredTypes[0];
  if (fallbackAgent) {
    return fallbackAgent;
  }

  throw new Error("No agent backends registered");
}
