import { s3 } from "./s3.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

import fsp from "node:fs/promises";
import path from "node:path";

import { config, logger } from "./config.js";
import type { TranscoderPayload, CompletedNotification, FailedNotification, DownloadResult } from "./types.js";

import { downloadFile } from "./phases/download-file.js";
import { retry } from "./helper/retry.js";
import { uploadWithRetry } from "./helper/uploadWithRetry.js";
import { notify } from "./helper/notify.js";
import { cleanupPartialUploads } from "./helper/cleanupPartialUploads.js";
import { thumbnailGenAndUpload } from "./phases/thumbnail.js";
import { transcode } from "./phases/ffmpe.js";

// Supported output resolutions for transcoding
const RESOLUTIONS = [
  { name: "240p", width: 426, height: 240 },
  { name: "360p", width: 640, height: 360 },
  { name: "480p", width: 854, height: 480 },
  { name: "720p", width: 1280, height: 720 },
] as const;

export default async function processJob(payload: TranscoderPayload) {
  const { videoId, objectKey, correlationId, deliveryTag, thumbnailKey } = payload;
  const jobStartedAt = Date.now();
  const workDir = path.join(config.TEMP_DIR, "jobs", `${videoId}-${jobStartedAt}`);
  const inputDir = path.join(workDir, "input");
  const outputDir = path.join(workDir, "output");
  const inputFile = path.join(inputDir, "original.mp4");

  const uploadedKeys: string[] = [];
  let jobCompletedSuccessfully = false;

  const baseContext = { videoId, objectKey, correlationId, deliveryTag };

  logger.info(baseContext, "Job started");

  try {
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.mkdir(outputDir, { recursive: true });

    // 1. Download source file from temp S3 bucket
    const downloadResult: DownloadResult = await downloadFile({
      inputFile,
      objectKey,
      baseContext,
    });

    // 2. Transcode to all target resolutions
    const qualities: string[] = [];

    for (const { name, width, height } of RESOLUTIONS) {
      const output = path.join(outputDir, `${name}.mp4`);
      const prodKey = `videos/${videoId}/${name}.mp4`;

      logger.info(
        { ...baseContext, resolution: name, target: `${width}x${height}` },
        "Transcoding started"
      );

      const transcodeStart = Date.now();
      await transcode({
        input: inputFile,
        output,
        width,
        height,
        timeoutMs: config.FFMPEG_TIMEOUT_MS,
      });
      const transcodeDuration = Date.now() - transcodeStart;

      const outputStat = await fsp.stat(output);

      logger.info(
        {
          ...baseContext,
          resolution: name,
          sizeBytes: outputStat.size,
          durationMs: transcodeDuration,
        },
        "Transcoding completed"
      );

      // Upload to production S3 bucket with retry mechanism
      const uploadStart = Date.now();
      await uploadWithRetry(config.aws.S3_PROD_BUCKET, prodKey, output, "video/mp4", name, videoId);
      const uploadDuration = Date.now() - uploadStart;

      uploadedKeys.push(prodKey);
      qualities.push(name);

      logger.info(
        { ...baseContext, resolution: name, durationMs: uploadDuration, key: prodKey },
        "Upload completed"
      );
    }

    // 2.1 Copy existing thumbnail to production, or generate and upload a new one
    await thumbnailGenAndUpload({ thumbnailKey: thumbnailKey ?? null });

    // 3. Mark success and notify backend
    jobCompletedSuccessfully = true;

    const completedPayload: CompletedNotification = {
      videoId,
      status: "PUBLISHED",
      qualities,
      objectKey,
    };

    const notifyStart = Date.now();
    await notify(completedPayload, correlationId, deliveryTag, false);
    const notifyDuration = Date.now() - notifyStart;

    const downloadDuration = downloadResult.durationMs;

    logger.info(
      {
        ...baseContext,
        status: "completed",
        runtimeMs: Date.now() - jobStartedAt,
        downloadDuration,
        transcodeCount: qualities.length,
        uploadCount: uploadedKeys.length,
        notifyDuration,
      },
      "Job completed"
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;

    logger.error(
      {
        ...baseContext,
        err: { message: errorMessage, stack: errorStack },
        uploadedKeys,
      },
      "Job failed"
    );

    // Cleanup partial uploads
    await cleanupPartialUploads(uploadedKeys, videoId);

    // Notify failure
    const failedPayload: FailedNotification = {
      videoId,
      error: errorMessage,
    };

    try {
      await notify(failedPayload, correlationId, deliveryTag, true);
    } catch (notifyErr) {
      logger.error(
        {
          ...baseContext,
          err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        },
        "Failed to send error notification"
      );
    }

    throw err;
  } finally {
    // Cleanup local temp directory
    try {
      logger.info({ videoId, workDir }, "Cleanup started");
      await fsp.rm(workDir, { recursive: true, force: true });
      logger.info({ videoId }, "Cleanup completed");
    } catch (rmErr) {
      logger.error(
        { videoId, err: rmErr instanceof Error ? rmErr.message : String(rmErr) },
        "Cleanup failed"
      );
    }

    // Conditionally purge temp source from S3 only on success
    if (jobCompletedSuccessfully) {
      logger.info({ videoId, objectKey }, "Deleting temp source");

      try {
        await retry(
          async () => {
            await s3.send(
              new DeleteObjectCommand({ Bucket: config.aws.S3_TEMP_BUCKET, Key: objectKey })
            );
          },
          3,
          1000,
        );
        logger.info({ videoId, objectKey }, "Temp source deleted");
      } catch (delErr) {
        logger.error(
          { videoId, objectKey, err: delErr instanceof Error ? delErr.message : String(delErr) },
          "Failed to delete temp source"
        );
      }
    } else {
      logger.warn({ videoId, objectKey }, "Preserving temp source for retry/troubleshooting");
    }

    logger.info({ videoId, totalRuntimeMs: Date.now() - jobStartedAt }, "Job finished");
  }
}
