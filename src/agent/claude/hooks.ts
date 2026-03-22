import type { HookCallbackMatcher, HookEvent, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../../util/logger.js";

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\b).*\//,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\s+/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bmkfs\b/,
  /\bcurl\s+.*\|\s*(ba)?sh\b/,
];

function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command matching: ${pattern.source}`;
    }
  }
  return null;
}

function preToolUseHook(
  input: PreToolUseHookInput
): SyncHookJSONOutput {
  const toolInput = input.tool_input as Record<string, unknown>;

  if (input.tool_name === "Bash" && typeof toolInput.command === "string") {
    const reason = isDangerousCommand(toolInput.command);
    if (reason) {
      logger.warn(`Blocked dangerous tool use: ${reason}`);
      return {
        decision: "block",
        reason,
      };
    }
  }

  return { decision: "approve" };
}

export function createHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input, _toolUseId, _options) => {
            if (input.hook_event_name === "PreToolUse") {
              return preToolUseHook(input);
            }
            return {};
          },
        ],
      },
    ],
  };
}
