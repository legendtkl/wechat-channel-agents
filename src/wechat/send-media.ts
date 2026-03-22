import { sendMessage, buildBaseInfo } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";
import { getContextToken } from "./context-token.js";
import { uploadFile, type UploadedFileInfo } from "../cdn/upload.js";
import { generateId } from "../util/random.js";
import { logger } from "../util/logger.js";

function buildImageItem(upload: UploadedFileInfo): MessageItem {
  return {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: upload.downloadEncryptedQueryParam,
        aes_key: Buffer.from(upload.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: upload.fileSizeCiphertext,
    },
  };
}

function buildFileItem(upload: UploadedFileInfo, fileName: string): MessageItem {
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: upload.downloadEncryptedQueryParam,
        aes_key: Buffer.from(upload.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(upload.fileSize),
    },
  };
}

function buildVideoItem(upload: UploadedFileInfo): MessageItem {
  return {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: upload.downloadEncryptedQueryParam,
        aes_key: Buffer.from(upload.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: upload.fileSizeCiphertext,
    },
  };
}

async function sendMediaItem(
  apiOpts: WeixinApiOptions,
  toUserId: string,
  item: MessageItem,
): Promise<void> {
  const contextToken = getContextToken(toUserId);
  if (!contextToken) {
    logger.error(`Cannot send media: no contextToken for user=${toUserId}`);
    return;
  }

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: generateId("wechat-agents"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: contextToken,
    },
  };

  await sendMessage({ ...apiOpts, body: req });
}

export async function sendImage(
  apiOpts: WeixinApiOptions,
  toUserId: string,
  imageData: Buffer,
): Promise<void> {
  const upload = await uploadFile(apiOpts, toUserId, imageData, UploadMediaType.IMAGE);
  await sendMediaItem(apiOpts, toUserId, buildImageItem(upload));
}

export async function sendFile(
  apiOpts: WeixinApiOptions,
  toUserId: string,
  fileData: Buffer,
  fileName: string,
): Promise<void> {
  const upload = await uploadFile(apiOpts, toUserId, fileData, UploadMediaType.FILE);
  await sendMediaItem(apiOpts, toUserId, buildFileItem(upload, fileName));
}

export async function sendVideo(
  apiOpts: WeixinApiOptions,
  toUserId: string,
  videoData: Buffer,
): Promise<void> {
  const upload = await uploadFile(apiOpts, toUserId, videoData, UploadMediaType.VIDEO);
  await sendMediaItem(apiOpts, toUserId, buildVideoItem(upload));
}
