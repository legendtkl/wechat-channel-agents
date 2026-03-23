import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppConfig } from "./types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

interface FileConfig {
  defaultAgent?: string;
  wechat?: {
    baseUrl?: string;
    routeTag?: string | null;
    botType?: string;
  };
  codex?: {
    model?: string;
    sandboxMode?: string;
    workingDirectory?: string;
  };
  stateDir?: string;
  allowedUsers?: string[];
  adminUsers?: string[];
  maxSessionAge?: number;
  textChunkLimit?: number;
  logLevel?: string;
}

function parseUserList(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): AppConfig {
  const configPath =
    process.env.WECHAT_AGENTS_CONFIG ||
    path.join(process.cwd(), "config.json");

  let fileConfig: FileConfig = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw) as FileConfig;
  }

  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "";
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN || "";
  const allowedUsers = fileConfig.allowedUsers ?? parseUserList(process.env.ALLOWED_USERS) ?? [];
  const adminUsers = fileConfig.adminUsers ?? parseUserList(process.env.ADMIN_USERS) ?? [];

  const config: AppConfig = {
    defaultAgent: (fileConfig.defaultAgent as AppConfig["defaultAgent"]) || "claude",
    wechat: {
      baseUrl: fileConfig.wechat?.baseUrl || "https://ilinkai.weixin.qq.com",
      routeTag: fileConfig.wechat?.routeTag ?? null,
      botType: fileConfig.wechat?.botType || "3",
    },
    anthropicBaseUrl,
    anthropicAuthToken,
    codex: {
      model: fileConfig.codex?.model,
      sandboxMode: fileConfig.codex?.sandboxMode || "danger-full-access",
      workingDirectory: resolvePath(fileConfig.codex?.workingDirectory || "."),
    },
    stateDir: resolvePath(fileConfig.stateDir || "~/.wechat-agents"),
    allowedUsers,
    adminUsers,
    maxSessionAge: fileConfig.maxSessionAge ?? 86_400_000,
    textChunkLimit: fileConfig.textChunkLimit ?? 4000,
    logLevel: fileConfig.logLevel ?? process.env.LOG_LEVEL ?? "INFO",
  };

  return config;
}
