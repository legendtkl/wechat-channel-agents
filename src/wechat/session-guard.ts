import { logger } from "../util/logger.js";

const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;

export const SESSION_EXPIRED_ERRCODE = -14;

let pauseUntil: number | null = null;

export function pauseSession(): void {
  const until = Date.now() + SESSION_PAUSE_DURATION_MS;
  pauseUntil = until;
  logger.info(
    `session-guard: paused until=${new Date(until).toISOString()} (${SESSION_PAUSE_DURATION_MS / 1000}s)`,
  );
}

export function isSessionPaused(): boolean {
  if (pauseUntil === null) return false;
  if (Date.now() >= pauseUntil) {
    pauseUntil = null;
    return false;
  }
  return true;
}

export function getRemainingPauseMs(): number {
  if (pauseUntil === null) return 0;
  const remaining = pauseUntil - Date.now();
  if (remaining <= 0) {
    pauseUntil = null;
    return 0;
  }
  return remaining;
}
