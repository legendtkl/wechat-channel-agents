import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const LOGIN_TIMEOUT_MS = 480_000;

export const DEFAULT_ILINK_BOT_TYPE = "3";

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  routeTag?: string | null,
): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    base,
  );
  logger.info(`Fetching QR code from: ${url.toString()}`);

  const headers: Record<string, string> = {};
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} body=${body}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  routeTag?: string | null,
): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );

  const headers: Record<string, string> = {
    "iLink-App-ClientVersion": "1",
  };
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Failed to poll QR status: ${response.status} ${response.statusText} body=${rawText}`,
      );
    }
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export async function loginWithQr(opts: {
  apiBaseUrl: string;
  botType?: string;
  routeTag?: string | null;
}): Promise<LoginResult> {
  const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
  let qrResponse = await fetchQRCode(opts.apiBaseUrl, botType, opts.routeTag);
  logger.info(`QR code received, qrcode=${redactToken(qrResponse.qrcode)}`);

  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrResponse.qrcode_img_content, { small: true });
  } catch {
    process.stdout.write(`QR Code URL: ${qrResponse.qrcode_img_content}\n`);
  }
  process.stdout.write("请使用微信扫描以上二维码...\n");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const statusResponse = await pollQRStatus(
      opts.apiBaseUrl,
      qrResponse.qrcode,
      opts.routeTag,
    );

    switch (statusResponse.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\n已扫码，在微信继续操作...\n");
          scannedPrinted = true;
        }
        break;

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          throw new Error("登录超时：二维码多次过期");
        }
        process.stdout.write(
          `\n二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`,
        );
        qrResponse = await fetchQRCode(opts.apiBaseUrl, botType, opts.routeTag);
        scannedPrinted = false;
        try {
          const qrterm = await import("qrcode-terminal");
          qrterm.default.generate(qrResponse.qrcode_img_content, { small: true });
        } catch {
          process.stdout.write(`QR Code URL: ${qrResponse.qrcode_img_content}\n`);
        }
        break;
      }

      case "confirmed": {
        if (!statusResponse.ilink_bot_id) {
          throw new Error("登录失败：服务器未返回 ilink_bot_id");
        }
        logger.info(`Login confirmed! ilink_bot_id=${statusResponse.ilink_bot_id}`);
        process.stdout.write("与微信连接成功！\n");
        return {
          token: statusResponse.bot_token ?? "",
          accountId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl ?? opts.apiBaseUrl,
          userId: statusResponse.ilink_user_id,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("登录超时，请重试");
}
