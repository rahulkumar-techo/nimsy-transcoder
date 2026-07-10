import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { execFile, execSync } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpegPath from "ffmpeg-static";
import { promisify } from "node:util";
import { config, logger } from "../config.js";
import { s3 } from "../s3.js";

const execFileAsync = promisify(execFile);

// Resolve FFmpeg binary path once at module load.
const resolvedFfmpeg = resolveFfmpegPath();

function resolveFfmpegPath(): string {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) return envPath;

  try {
    return execSync("command -v ffmpeg", { encoding: "utf8" }).trim();
  } catch {
    if (typeof ffmpegPath === "string") return ffmpegPath;
    throw new Error("FFmpeg binary not found. Set FFMPEG_PATH or install ffmpeg.");
  }
}

const TMP = process.env.TMPDIR || os.tmpdir();

interface ThumbnailPayload {
  thumbnailKey: string | null;   // If provided, copy from temp to prod bucket.
  videoObjectKey: string;        // Source video path in S3 temp bucket.
  videoId: string;
}

/**
 * Move an existing thumbnail from temp to prod, or generate one from the video.
 */
export async function thumbnailGenAndUpload(payload: ThumbnailPayload): Promise<string> {
  const targetKey = payload.thumbnailKey || `videos/${payload.videoId}/thumbnail.jpg`;

  // CASE 1: Pre-generated thumbnail exists — copy it.
  if (payload.thumbnailKey) {
    return moveThumbnail(payload.thumbnailKey, targetKey);
  }

  // CASE 2: Generate thumbnail from video frame.
  return generateThumbnail(payload.videoObjectKey, targetKey);
}

/**
 * Copy thumbnail from temp bucket to prod bucket, then delete the temp copy.
 */
async function moveThumbnail(sourceKey: string, targetKey: string): Promise<string> {
  logger.info({ thumbnailKey: sourceKey }, "Moving thumbnail to production");

  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: config.aws.S3_PROD_BUCKET,
        CopySource: `${config.aws.S3_TEMP_BUCKET}/${encodeURIComponent(sourceKey)}`,
        Key: targetKey,
      })
    );

    await s3.send(
      new DeleteObjectCommand({
        Bucket: config.aws.S3_TEMP_BUCKET,
        Key: sourceKey,
      })
    );

    return targetKey;
  } catch (err) {
    logger.error({ err, thumbnailKey: sourceKey }, "Failed to move thumbnail");
    throw err;
  }
}

/**
 * Download video to temp file, extract frame at 2s, upload JPEG to prod bucket.
 */
async function generateThumbnail(videoKey: string, targetKey: string): Promise<string> {
  logger.info({ videoKey }, "Generating thumbnail from video");

  const tmpDir = await fs.mkdtemp(path.join(TMP, "thumb-"));
  const videoPath = path.join(tmpDir, "video.mp4");
  const thumbPath = path.join(tmpDir, "thumbnail.jpg");

  try {
    // 1. Download video from S3.
    const { Body } = await s3.send(
      new GetObjectCommand({
        Bucket: config.aws.S3_TEMP_BUCKET,
        Key: videoKey,
      })
    );

    if (!Body) {
      throw new Error(`Empty S3 body for key: ${videoKey}`);
    }

    await pipeline(Body as NodeJS.ReadableStream, createWriteStream(videoPath));

    const stats = await fs.stat(videoPath);
    logger.info({ videoKey, sizeMb: (stats.size / 1024 / 1024).toFixed(1) }, "Video downloaded for thumbnail");

    // 2. Extract single frame at 2 seconds using FFmpeg.
    await extractFrame(videoPath, thumbPath);

    // 3. Upload JPEG to prod bucket.
    await s3.send(
      new PutObjectCommand({
        Bucket: config.aws.S3_PROD_BUCKET,
        Key: targetKey,
        Body: createReadStream(thumbPath),
        ContentType: "image/jpeg",
      })
    );

    logger.info({ targetKey }, "Thumbnail uploaded");
    return targetKey;

  } finally {
    // 4. Cleanup temp files.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run FFmpeg to extract one frame at the 2-second mark.
 */
async function extractFrame(videoPath: string, outputPath: string): Promise<void> {
  const args = [
    "-y",
    "-ss", "00:00:02",   // Seek to 2 seconds.
    "-i", videoPath,      // Input file.
    "-vframes", "1",     // Extract exactly 1 frame.
    "-q:v", "4",          // JPEG quality (1-31, lower is better).
    "-f", "image2",      // Force image output format.
    outputPath,
  ];

  const { stderr } = await execFileAsync(resolvedFfmpeg, args, {
    timeout: 60000,           // 1 minute should be plenty for a single frame.
    maxBuffer: 1024 * 1024,   // 1 MB stderr cap.
  });

  if (stderr) {
    logger.debug({ stderr: stderr.slice(0, 500) }, "FFmpeg thumbnail stderr");
  }
}

/*
| Before                                       | After                                          |
| -------------------------------------------- | ---------------------------------------------- |
| Stream video from S3 → FFmpeg → S3 upload    | Download video file → FFmpeg → upload JPEG     |
| `spawn` + `PassThrough` + `Upload` multipart | `execFile` + file paths + `PutObjectCommand`   |
| `ffmpeg.stderr.resume()` (silent swallow)    | Captured and logged                            |
| No temp file cleanup                         | `finally` block deletes everything             |
| `resolvedFfmpeg \|\| "ffmpeg"` fallback      | Proper `resolveFfmpegPath()` function          |
| `execSync.execSync` typo                     | Fixed to `execSync` import + `execSync()` call |
| No download size check                       | Logs downloaded size for debugging             |

*/ 