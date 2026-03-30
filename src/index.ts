import { loadConfig } from "./config.js";
import { setLogLevel, setLogFile, logger } from "./util/logger.js";
import { StateManager, type PersistedWechatAccount } from "./storage/state.js";
import { initSessions, cleanupSessions } from "./storage/sessions.js";
import { setAllowedUsers, setAdminUsers } from "./auth/allowlist.js";
import { loginWithQr } from "./wechat/login.js";
import { startMonitor } from "./wechat/monitor.js";
import {
  initContextTokenStore,
  clearContextTokens,
  clearContextTokensForAccount,
} from "./wechat/context-token.js";
import type { WeixinApiOptions } from "./wechat/api.js";
import { registerAgent } from "./agent/registry.js";
import { ClaudeBackend } from "./agent/claude/backend.js";
import { CodexBackend } from "./agent/codex/backend.js";
import { createDispatcher } from "./bridge/dispatcher.js";
import { installDnsBypass } from "./util/dns-bypass.js";
import path from "node:path";

async function main(): Promise<void> {
  // 0. Bypass /etc/hosts (MOADeploy rewrites it)
  installDnsBypass();

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
  initContextTokenStore(config.stateDir);

  // 6. Register agent backends
  registerAgent(new ClaudeBackend(config));
  logger.info("Registered Claude backend");

  registerAgent(new CodexBackend(config));
  logger.info("Registered Codex backend");

  // 7. Create shutdown controls and dispatcher
  const cleanupInterval = setInterval(() => {
    cleanupSessions(config.maxSessionAge);
  }, 60 * 60 * 1000);

  const monitorControllers = new Map<string, AbortController>();
  const monitorPromises = new Map<string, Promise<void>>();
  let loginInFlight: Promise<{ accountId: string }> | null = null;
  let shuttingDown = false;
  let resolveShutdown!: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const buildApiOpts = (account: PersistedWechatAccount): WeixinApiOptions => ({
    baseUrl: account.baseUrl,
    token: account.token,
    routeTag: config.wechat.routeTag,
  });

  const stopAccountMonitor = (accountId: string): void => {
    const controller = monitorControllers.get(accountId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  };

  const shutdown = (message: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(message);
    clearInterval(cleanupInterval);
    for (const controller of monitorControllers.values()) {
      controller.abort();
    }
    resolveShutdown();
  };

  const startAccountMonitor = (account: PersistedWechatAccount): void => {
    if (monitorControllers.has(account.accountId)) {
      return;
    }

    const controller = new AbortController();
    monitorControllers.set(account.accountId, controller);

    const monitorPromise = (async () => {
      try {
        await startMonitor({
          accountId: account.accountId,
          apiOpts: buildApiOpts(account),
          getUpdatesBuf: account.getUpdatesBuf ?? "",
          onBufUpdate: (buf) => stateManager.updateAccount(account.accountId, { getUpdatesBuf: buf }),
          onMessage: dispatch,
          abortSignal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || shuttingDown) {
          logger.info(`Monitor stopped for accountId=${account.accountId}`);
        } else {
          logger.error(`Monitor error for accountId=${account.accountId}: ${String(err)}`);
        }
      } finally {
        if (monitorControllers.get(account.accountId) === controller) {
          monitorControllers.delete(account.accountId);
        }
        monitorPromises.delete(account.accountId);
      }
    })();

    monitorPromises.set(account.accountId, monitorPromise);
  };

  const handleAccountLogin = async (): Promise<{ accountId: string }> => {
    if (shuttingDown) {
      throw new Error("Service is shutting down");
    }
    if (loginInFlight) {
      throw new Error("Another account login is already in progress");
    }

    loginInFlight = (async () => {
      const loginResult = await loginWithQr({
        apiBaseUrl: config.wechat.baseUrl,
        botType: config.wechat.botType,
        routeTag: config.wechat.routeTag,
      });

      const account: PersistedWechatAccount = {
        token: loginResult.token,
        accountId: loginResult.accountId,
        baseUrl: loginResult.baseUrl,
        userId: loginResult.userId,
        getUpdatesBuf: "",
      };

      const { removedAccountIds } = stateManager.upsertAccount(account);
      for (const removedAccountId of removedAccountIds) {
        logger.info(`Replacing stale accountId=${removedAccountId} after re-login`);
        stopAccountMonitor(removedAccountId);
        clearContextTokensForAccount(removedAccountId);
      }

      startAccountMonitor(account);
      logger.info(
        `Account connected: accountId=${account.accountId} total=${stateManager.listAccounts().length}`,
      );
      return { accountId: account.accountId };
    })();

    try {
      return await loginInFlight;
    } finally {
      loginInFlight = null;
    }
  };

  const handleLogout = async () => {
    logger.warn("Logout requested via command. Clearing persisted credentials for all accounts.");
    clearContextTokens();
    stateManager.clearAccounts();
    shutdown("Shutting down after logout...");
  };

  const dispatch = createDispatcher({
    config,
    onLogout: handleLogout,
    onLogin: handleAccountLogin,
    listAccounts: () => stateManager.listAccounts().map((account) => account.accountId),
  });

  const gracefulShutdown = () => {
    shutdown("Shutting down...");
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  // 8. Login the first account if needed, then start all saved accounts
  if (stateManager.listAccounts().length === 0) {
    logger.info("No bot accounts found, starting QR login...");
    await handleAccountLogin();
  } else {
    logger.info(`Loaded ${stateManager.listAccounts().length} bot account(s) from state`);
  }

  for (const account of stateManager.listAccounts()) {
    logger.info(`Starting account monitor for accountId=${account.accountId}`);
    startAccountMonitor(account);
  }

  logger.info("Bridge is running. Send a message in WeChat to start chatting.");

  await shutdownPromise;
  await Promise.allSettled([...monitorPromises.values()]);
  logger.info("Goodbye!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
