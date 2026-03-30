import type { CDNMedia, ImageItem, FileItem, VoiceItem, VideoItem } from "../wechat/types.js";
import { cdnDownloadDecrypt } from "../cdn/pic-decrypt.js";
import { logger } from "../util/logger.js";

export async function downloadImage(item: ImageItem): Promise<Buffer | null> {
  const mediaCandidates: Array<{ label: string; media?: CDNMedia }> = [
    { label: "media", media: item.media },
    { label: "thumb_media", media: item.thumb_media },
  ];

  let hadCandidate = false;
  let lastError: Error | null = null;

  for (const candidate of mediaCandidates) {
    const media = candidate.media;
    if (!media?.encrypt_query_param || !media?.aes_key) {
      continue;
    }

    hadCandidate = true;

    try {
      return await cdnDownloadDecrypt(media.encrypt_query_param, media.aes_key);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Image ${candidate.label} download failed: ${lastError.message}`);
    }
  }

  if (!hadCandidate) {
    logger.warn(
      `Image item missing CDN media info: media=${Boolean(item.media?.encrypt_query_param)} thumb_media=${Boolean(item.thumb_media?.encrypt_query_param)} url=${Boolean(item.url)} aeskey=${Boolean(item.aeskey)}`,
    );
  }

  if (lastError) {
    throw lastError;
  }

  return null;
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
