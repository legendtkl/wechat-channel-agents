import fs from "node:fs";
import path from "node:path";

const LEVEL_IDS: Record<string, number> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

let minLevelId = LEVEL_IDS.INFO;

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (!(upper in LEVEL_IDS)) {
    throw new Error(
      `Invalid log level: ${level}. Valid: ${Object.keys(LEVEL_IDS).join(", ")}`,
    );
  }
  minLevelId = LEVEL_IDS[upper];
}

let logFilePath: string | null = null;

export function setLogFile(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = filePath;
}

function formatTime(now: Date): string {
  return now.toISOString().replace("T", " ").replace("Z", "");
}

function writeLog(level: string, message: string): void {
  const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
  if (levelId < minLevelId) return;

  const now = new Date();
  const line = `${formatTime(now)} [${level}] ${message}`;

  if (levelId >= LEVEL_IDS.ERROR) {
    console.error(line);
  } else {
    console.log(line);
  }

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`, "utf-8");
    } catch {
      // Best-effort
    }
  }
}

export interface Logger {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const logger: Logger = {
  info(message: string): void {
    writeLog("INFO", message);
  },
  debug(message: string): void {
    writeLog("DEBUG", message);
  },
  warn(message: string): void {
    writeLog("WARN", message);
  },
  error(message: string): void {
    writeLog("ERROR", message);
  },
};
