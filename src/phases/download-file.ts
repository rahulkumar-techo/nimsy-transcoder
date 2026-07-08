import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";
import { s3 } from "../s3.js";
import { config, logger } from "../config.js";
import { DownloadPayload, DownloadResult } from "../types.js";

// Timeout for a single download attempt.
// Override with env DOWNLOAD_TIMEOUT_MS=120000 for slower networks.
// Example:
//   DOWNLOAD_TIMEOUT_MS=120000 node dist/index.js
const DOWNLOAD_TIMEOUT_MS =
  parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "60000", 10);

// Stream an S3 object to a local file with timeout and cleanup.
//
// Example payload:
//   {
//     inputFile: "/tmp/transcoder/jobs/.../input/original.mp4",
//     objectKey: "videos/759dbed8-.../original.mp4",
//     baseContext: { videoId, objectKey, correlationId, deliveryTag }
//   }
//
// Example result:
//   { inputFile, durationMs: 7907, sizeBytes: 10677875 }
export async function downloadFile(payload: DownloadPayload): Promise<DownloadResult> {
  const { inputFile, objectKey, baseContext } = payload;
  const ac = new AbortController();

  logger.info({ ...baseContext, bucket: config.aws.S3_TEMP_BUCKET }, "Download started");

  const downloadStart = Date.now();
  const prePareDownload = await s3.send(
    new GetObjectCommand({ Bucket: config.aws.S3_TEMP_BUCKET, Key: objectKey })
  );

  if (!prePareDownload?.Body) throw new Error("Download failed: empty response body");

  try {
    await Promise.race([
      // Stream response body directly to disk.
      pipeline(
        prePareDownload.Body as NodeJS.ReadableStream,
        fs.createWriteStream(inputFile),
        { signal: ac.signal }
      ),
      // Hard timeout so a stalled download does not hang forever.
      delay(DOWNLOAD_TIMEOUT_MS, null, { signal: ac.signal }).then(() => {
        throw new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`);
      }),
    ]);

    const inputStat = await fsp.stat(inputFile);
    const durationMs = Date.now() - downloadStart;

    logger.info(
      { ...baseContext, durationMs, sizeBytes: inputStat.size },
      "Download completed"
    );

    return { inputFile, durationMs, sizeBytes: inputStat.size };
  } catch (error: any) {
    logger.error({ ...baseContext, error: error.message }, "Download failed");

    try {
      await fsp.rm(inputFile, { force: true });
    } catch {
      // Ignore cleanup errors if file never got created
    }

    throw error;
  } finally {
    ac.abort();
  }
}
