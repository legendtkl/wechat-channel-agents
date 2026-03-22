import { sendMessage as sendMessageApi } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";

function generateClientId(): string {
  return generateId("wechat-agents");
}

export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, then strip pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .join("  "),
  );
  // Bold/italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");
  // Inline code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "");
  // Blockquotes
  result = result.replace(/^>\s?/gm, "");
  // Unordered lists
  result = result.replace(/^[\s]*[-*+]\s+/gm, "• ");
  return result.trim();
}

export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendTextMessage: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendTextMessage: contextToken is required");
  }
  const clientId = generateClientId();
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: opts.contextToken,
    },
  };
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      routeTag: opts.routeTag,
      body: req,
    });
  } catch (err) {
    logger.error(`sendTextMessage: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}
