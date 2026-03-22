import { getUpdates } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import type { WeixinMessage } from "./types.js";
import { WeixinConfigManager } from "./config-cache.js";
import {
  SESSION_EXPIRED_ERRCODE,
  pauseSession,
  getRemainingPauseMs,
} from "./session-guard.js";
import { logger } from "../util/logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MessageHandler = (
  msg: WeixinMessage,
  typingTicket: string,
) => void | Promise<void>;

export interface MonitorOptions {
  apiOpts: WeixinApiOptions;
  getUpdatesBuf: string;
  onBufUpdate: (buf: string) => void;
  onMessage: MessageHandler;
  abortSignal?: AbortSignal;
}

export async function startMonitor(opts: MonitorOptions): Promise<void> {
  const { apiOpts, onMessage, abortSignal } = opts;

  logger.info(`Monitor started: baseUrl=${apiOpts.baseUrl}`);

  let getUpdatesBuf = opts.getUpdatesBuf;

  const configManager = new WeixinConfigManager(
    {
      baseUrl: apiOpts.baseUrl,
      token: apiOpts.token,
      routeTag: apiOpts.routeTag,
    },
    (msg) => logger.info(msg),
  );

  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: apiOpts.baseUrl,
        token: apiOpts.token,
        routeTag: apiOpts.routeTag,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE ||
          resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          pauseSession();
          const pauseMs = getRemainingPauseMs();
          logger.error(
            `getUpdates: session expired (errcode=${SESSION_EXPIRED_ERRCODE}), pausing for ${Math.ceil(pauseMs / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        logger.error(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(
            `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        getUpdatesBuf = resp.get_updates_buf;
        opts.onBufUpdate(getUpdatesBuf);
      }

      const list = resp.msgs ?? [];
      for (const msg of list) {
        logger.info(
          `inbound message: from=${msg.from_user_id} types=${msg.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const fromUserId = msg.from_user_id ?? "";
        const cachedConfig = await configManager.getForUser(
          fromUserId,
          msg.context_token,
        );

        try {
          await onMessage(msg, cachedConfig.typingTicket);
        } catch (err) {
          logger.error(`Message handler error: from=${fromUserId} err=${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        logger.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      logger.error(
        `getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
        );
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  logger.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
