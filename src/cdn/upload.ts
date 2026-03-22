import crypto from "node:crypto";
import { aesEcbEncrypt, aesEcbPaddedSize, generateAesKey } from "./aes-ecb.js";
import { cdnUpload } from "./cdn-upload.js";
import { randomHex } from "../util/random.js";
import { getUploadUrl, buildBaseInfo } from "../wechat/api.js";
import type { WeixinApiOptions } from "../wechat/api.js";
import { logger } from "../util/logger.js";

export interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

export async function uploadFile(
  apiOpts: WeixinApiOptions,
  toUserId: string,
  data: Buffer,
  mediaType: number,
): Promise<UploadedFileInfo> {
  const filekey = randomHex(16);
  const aesKey = generateAesKey();
  const aeskeyHex = aesKey.toString("hex");

  const rawsize = data.length;
  const rawfilemd5 = crypto.createHash("md5").update(data).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);

  logger.debug(`Requesting upload URL: filekey=${filekey} mediaType=${mediaType} rawsize=${rawsize}`);

  const uploadResp = await getUploadUrl({
    ...apiOpts,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
      base_info: buildBaseInfo(),
    },
  });

  if (!uploadResp.upload_param) {
    throw new Error("No upload_param in getUploadUrl response");
  }

  const ciphertext = aesEcbEncrypt(data, aesKey);
  const downloadParam = await cdnUpload(uploadResp.upload_param, filekey, ciphertext);

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskeyHex,
    fileSize: rawsize,
    fileSizeCiphertext: ciphertext.length,
  };
}
