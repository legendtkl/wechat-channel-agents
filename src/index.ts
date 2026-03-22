import { loadConfig } from "./config.js";
import { setLogLevel, setLogFile, logger } from "./util/logger.js";
import { StateManager } from "./storage/state.js";
import { initSessions, cleanupSessions } from "./storage/sessions.js";
import { setAllowedUsers, setAdminUsers } from "./auth/allowlist.js";
import { loginWithQr } from "./wechat/login.js";
import { startMonitor } from "./wechat/monitor.js";
import { registerAgent } from "./agent/registry.js";
import { ClaudeBackend } from "./agent/claude/backend.js";
import { CodexBackend } from "./agent/codex/backend.js";
import { createDispatcher } from "./bridge/dispatcher.js";
import path from "node:path";

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();

  // 2. Init logger
  setLogLevel(config.logLevel);
  setLogFile(path.join(config.stateDir, "wechat-agents.log"));
  logger.info("Starting wechat-channel-agents...");
  logger.info(`Config: defaultAgent=${config.defaultAgent} wechat.baseUrl=${config.wechat.baseUrl}`);

  // 3. Init sessions
  initSessions(config.stateDir);

  // 4. Setup allowlist
  setAllowedUsers(config.allowedUsers);
  setAdminUsers(config.adminUsers);

  // 5. Load persisted state
  const stateManager = new StateManager(config.stateDir);
  stateManager.load();

  // 6. Login if needed
  const state = stateManager.get();
  let credentials = state.credentials;

  if (!credentials) {
    logger.info("No credentials found, starting QR login...");
    const loginResult = await loginWithQr({
      apiBaseUrl: config.wechat.baseUrl,
      botType: config.wechat.botType,
      routeTag: config.wechat.routeTag,
    });
    credentials = {
      token: loginResult.token,
      accountId: loginResult.accountId,
      baseUrl: loginResult.baseUrl,
      userId: loginResult.userId,
    };
    stateManager.update({ credentials });
    logger.info(`Credentials saved for accountId=${credentials.accountId}`);
  } else {
    logger.info(`Using saved credentials for accountId=${credentials.accountId}`);
  }

  // 7. Register agent backends
  if (config.anthropicBaseUrl && config.anthropicAuthToken) {
    registerAgent(new ClaudeBackend(config));
    logger.info("Registered Claude backend");
  } else {
    logger.warn("ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN not set, Claude backend disabled");
  }

  registerAgent(new CodexBackend(config));
  logger.info("Registered Codex backend");

  // 8. Create shutdown controls and dispatcher
  const abortController = new AbortController();
  const cleanupInterval = setInterval(() => {
    cleanupSessions(config.maxSessionAge);
  }, 60 * 60 * 1000);

  let shuttingDown = false;
  const shutdown = (message: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(message);
    abortController.abort();
    clearInterval(cleanupInterval);
  };

  const handleLogout = async () => {
    logger.warn("Logout requested via command. Clearing persisted credentials.");
    stateManager.update({
      credentials: undefined,
      getUpdatesBuf: "",
    });
    shutdown("Shutting down after logout...");
  };

  const apiOpts = {
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    routeTag: config.wechat.routeTag,
  };

  const dispatch = createDispatcher({ apiOpts, config, onLogout: handleLogout });

  const gracefulShutdown = () => {
    shutdown("Shutting down...");
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  logger.info("Bridge is running. Send a message in WeChat to start chatting.");

  try {
    await startMonitor({
      apiOpts,
      getUpdatesBuf: state.getUpdatesBuf ?? "",
      onBufUpdate: (buf) => stateManager.update({ getUpdatesBuf: buf }),
      onMessage: dispatch,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.info("Monitor stopped by signal");
    } else {
      logger.error(`Monitor error: ${String(err)}`);
      throw err;
    }
  } finally {
    clearInterval(cleanupInterval);
    logger.info("Goodbye!");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
