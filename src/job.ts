import { s3 } from "./s3.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

import { execSync } from "node:child_process";
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
import { transcode, type TranscodeOutput } from "./phases/ffmpe.js";

// Target resolutions for every transcoding job.
// To add/remove renditions, change this array.
// Example:
//   const RESOLUTIONS = [
//     { name: "360p", width: 640, height: 360 },
//     { name: "1080p", width: 1920, height: 1080 },
//   ];
const RESOLUTIONS: readonly Omit<TranscodeOutput, "path">[] = [
  { name: "240p", width: 426, height: 240 },
  { name: "360p", width: 640, height: 360 },
  { name: "480p", width: 854, height: 480 },
  { name: "720p", width: 1280, height: 720 },
] as const;

// Fail fast if the temp directory does not have enough free space.
// Required bytes is doubled as a safety margin for working files.
//
// Example:
//   assertDiskSpace("/tmp/transcoder", 50 * 1024 * 1024)
//   -> requires ~100 MB free
function assertDiskSpace(tempDir: string, requiredBytes: number) {
  const MIN_FREE_BYTES = requiredBytes * 2;

  try {
    // df -B1 gives byte-level free-space info.
    // Output example:
    //   /dev/root  51474468 40422616  11051852   79% /tmp/transcoder
    const df = execSync(`df -B1 "${tempDir}" 2>/dev/null | tail -1`, {
      encoding: "utf8",
    });
    const parts = df.trim().split(/\s+/);
    const available = parseInt(parts[3], 10);

    if (Number.isNaN(available) || available < MIN_FREE_BYTES) {
      throw new Error(
        `Insufficient disk space on ${tempDir}: need ~${(
          MIN_FREE_BYTES /
          1024 /
          1024 /
          1024
        ).toFixed(2)} GB free`
      );
    }
  } catch (err) {
    // Only rethrow the intentional disk-space failure.
    // Other errors, such as df missing on Windows, are logged and skipped.
    if (err instanceof Error && err.message.includes("Insufficient disk space")) {
      throw err;
    }
    logger.warn({ tempDir, err: err instanceof Error ? err.message : String(err) }, "Disk space check skipped");
  }
}

// One transcoding job lifecycle:
//   1. create temp dirs
//   2. check disk space
//   3. download source from temp S3 bucket
//   4. ffmpeg multi-output transcode
//   5. upload each rendition to production S3
//   6. thumbnail handling
//   7. notify backend
//   8. cleanup temp files
//   9. delete temp source from S3 on success
export default async function processJob(payload: TranscoderPayload) {
  const { videoId, objectKey, correlationId, deliveryTag, thumbnailKey } = payload;
  const jobStartedAt = Date.now();

  // Example paths:
  //   workDir: /tmp/transcoder/jobs/759dbed8-...-1783530746547
  //   inputFile: /tmp/transcoder/jobs/.../input/original.mp4
  //   outputDir: /tmp/transcoder/jobs/.../output
  const workDir = path.join(config.TEMP_DIR, "jobs", `${videoId}-${jobStartedAt}`);
  const inputDir = path.join(workDir, "input");
  const outputDir = path.join(workDir, "output");
  const inputFile = path.join(inputDir, "original.mp4");

  // Track which S3 uploads succeeded so they can be cleaned up on failure.
  const uploadedKeys: string[] = [];
  let jobCompletedSuccessfully = false;

  const baseContext = { videoId, objectKey, correlationId, deliveryTag };

  logger.info(baseContext, "Job started");

  try {
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.mkdir(outputDir, { recursive: true });

    // Abort early if there is not enough disk for the source + outputs.
    assertDiskSpace(config.TEMP_DIR, 50 * 1024 * 1024);

    // Step 1: download with retry.
    // Example result:
    //   { inputFile, durationMs: 7907, sizeBytes: 10677875 }
    const downloadResult: DownloadResult = await retry(
      () =>
        downloadFile({
          inputFile,
          objectKey,
          baseContext,
        }),
      3,     // max attempts
      2000,  // base backoff in ms
    );

    // Build output descriptors for all target resolutions.
    const outputs: TranscodeOutput[] = RESOLUTIONS.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      // Example:
      //   path: /tmp/transcoder/jobs/.../output/720p.mp4
      path: path.join(outputDir, `${r.name}.mp4`),
    }));

    logger.info(
      { ...baseContext, outputs: outputs.map((o) => o.name) },
      "Multi-output transcode started"
    );

    // Step 2: transcode all renditions in one ffmpeg pass.
    // Example result:
    //   { outputs: [{ name: "240p", path: "/tmp/.../240p.mp4" }, ...] }
    const transcodeStart = Date.now();
    const { outputs: completedOutputs } = await transcode({
      input: inputFile,
      outputs,
      timeoutMs: config.FFMPEG_TIMEOUT_MS,
    });
    const transcodeDuration = Date.now() - transcodeStart;

    logger.info(
      {
        ...baseContext,
        outputNames: completedOutputs.map((o) => o.name),
        durationMs: transcodeDuration,
      },
      "Multi-output transcode completed"
    );

    // Step 3: upload each rendition to production S3.
    for (const output of completedOutputs) {
      // Example:
      //   prodKey: videos/759dbed8-...-1783530746547/720p.mp4
      const prodKey = `videos/${videoId}/${output.name}.mp4`;

      const uploadStart = Date.now();
      await uploadWithRetry(config.aws.S3_PROD_BUCKET, prodKey, output.path, "video/mp4", output.name, videoId);
      const uploadDuration = Date.now() - uploadStart;

      uploadedKeys.push(prodKey);

      logger.info(
        { ...baseContext, resolution: output.name, durationMs: uploadDuration, key: prodKey },
        "Upload completed"
      );
    }

    // Step 4: thumbnail handling.
    await thumbnailGenAndUpload({ thumbnailKey: thumbnailKey ?? null });

    // Step 5: success path.
    jobCompletedSuccessfully = true;

    const completedPayload: CompletedNotification = {
      videoId,
      status: "PUBLISHED",
      qualities: completedOutputs.map((o) => o.name),
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
        transcodeDuration,
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

    // Cleanup partial uploads from production S3.
    await cleanupPartialUploads(uploadedKeys, videoId);

    // Notify backend so it can mark the video as failed.
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
    // Always remove local temp files.
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

    // Only delete the original temp source if the job succeeded.
    // On failure we keep it for retry/troubleshooting.
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
