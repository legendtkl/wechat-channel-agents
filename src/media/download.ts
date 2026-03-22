import type { ImageItem, FileItem, VoiceItem, VideoItem } from "../wechat/types.js";
import { cdnDownloadDecrypt } from "../cdn/pic-decrypt.js";
import { logger } from "../util/logger.js";

export async function downloadImage(item: ImageItem): Promise<Buffer | null> {
  const media = item.media;
  if (!media?.encrypt_query_param || !media?.aes_key) {
    logger.warn("Image item missing CDN media info");
    return null;
  }
  return cdnDownloadDecrypt(media.encrypt_query_param, media.aes_key);
}

export async function downloadFile(item: FileItem): Promise<Buffer | null> {
  const media = item.media;
  if (!media?.encrypt_query_param || !media?.aes_key) {
    logger.warn("File item missing CDN media info");
    return null;
  }
  return cdnDownloadDecrypt(media.encrypt_query_param, media.aes_key);
}

export async function downloadVoice(item: VoiceItem): Promise<Buffer | null> {
  const media = item.media;
  if (!media?.encrypt_query_param || !media?.aes_key) {
    logger.warn("Voice item missing CDN media info");
    return null;
  }
  return cdnDownloadDecrypt(media.encrypt_query_param, media.aes_key);
}

export async function downloadVideo(item: VideoItem): Promise<Buffer | null> {
  const media = item.media;
  if (!media?.encrypt_query_param || !media?.aes_key) {
    logger.warn("Video item missing CDN media info");
    return null;
  }
  return cdnDownloadDecrypt(media.encrypt_query_param, media.aes_key);
}
