import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../util/logger.js";

export interface ExternalSession {
  id: string;
  project: string;
  cwd: string;
  modifiedAt: number;
}

/**
 * Scan ~/.claude/projects/ for Claude Code CLI sessions.
 * Each project dir contains {sessionId}.jsonl transcript files.
 */
export function listClaudeCliSessions(limit = 20): ExternalSession[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const results: ExternalSession[] = [];

  try {
    if (!fs.existsSync(projectsDir)) return results;

    for (const projName of fs.readdirSync(projectsDir)) {
      const projPath = path.join(projectsDir, projName);
      if (!fs.statSync(projPath).isDirectory()) continue;

      // Project name is the cwd with slashes replaced by dashes
      // e.g. "-Users-white-workspace-foo" → "/Users/white/workspace/foo"
      const cwd = projName.replace(/^-/, "/").replace(/-/g, "/");
      const project = path.basename(cwd);

      for (const file of fs.readdirSync(projPath)) {
        if (!file.endsWith(".jsonl")) continue;

        const sessionId = file.replace(".jsonl", "");
        // Skip non-UUID filenames
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) continue;

        const filePath = path.join(projPath, file);
        try {
          const stat = fs.statSync(filePath);
          results.push({
            id: sessionId,
            project,
            cwd,
            modifiedAt: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch (err) {
    logger.warn(`Failed to scan Claude CLI sessions: ${String(err)}`);
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results.slice(0, limit);
}

/**
 * Scan ~/.codex/sessions/ for Codex CLI threads.
 * Files are stored as YYYY/MM/DD/rollout-{timestamp}-{threadId}.jsonl
 */
export function listCodexCliSessions(limit = 20): ExternalSession[] {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const results: ExternalSession[] = [];

  try {
    if (!fs.existsSync(sessionsDir)) return results;

    walkCodexSessions(sessionsDir, results);
  } catch (err) {
    logger.warn(`Failed to scan Codex CLI sessions: ${String(err)}`);
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results.slice(0, limit);
}

function walkCodexSessions(dir: string, results: ExternalSession[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCodexSessions(fullPath, results);
      continue;
    }

    if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;

    // filename: rollout-2026-03-30T01-11-58-019d3a94-ba51-7312-b41f-3c30da96fd97.jsonl
    // Extract thread ID: last 5 UUID-like segments (36 chars including dashes)
    const baseName = entry.name.replace(".jsonl", "");
    const threadId = extractCodexThreadId(baseName);
    if (!threadId) continue;

    // Extract cwd from session_meta in first line.
    // The line can be very large (embeds base_instructions), so read enough bytes.
    let cwd = "";
    try {
      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      if (meta?.type === "session_meta" && meta?.payload?.cwd) {
        cwd = meta.payload.cwd;
      }
    } catch {
      // ignore parse errors
    }

    try {
      const stat = fs.statSync(fullPath);
      results.push({
        id: threadId,
        project: cwd ? path.basename(cwd) : "unknown",
        cwd,
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Extract thread ID from codex rollout filename.
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-{uuid}
 * The UUID is 36 chars: 8-4-4-4-12 hex segments
 */
function extractCodexThreadId(baseName: string): string | null {
  // Match the last UUID-like segment (8-4-4-4-12)
  const match = baseName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return match ? match[1] : null;
}
