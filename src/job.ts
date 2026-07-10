import { s3 } from "./s3.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config, logger } from "./config.js";
import type { TranscoderPayload } from "./types.js";
import { retry } from "./helper/retry.js";
import { notify } from "./helper/notify.js";
import { cleanupPartialUploads } from "./helper/cleanupPartialUploads.js";
import { thumbnailGenAndUpload } from "./phases/thumbnail.js";
import { transcode } from "./phases/ffmpe.js";
import { downloadSource } from "./phases/download-file.js";
import { uploadFileWithRetry } from "./helper/uploadWithRetry.js";
import { getVideoDuration } from "./helper/video-info.js";

const TMP = process.env.TMPDIR || os.tmpdir();
const CPUS = os.cpus().length;
const IS_LOCAL = process.env.NODE_ENV !== "production"; 

function getResolutions(durationSec: number) {
  if (IS_LOCAL) {
    return [
      { name: "360p", width: 640, height: 360 },
      { name: "480p", width: 854, height: 480 },
      { name: "720p", width: 1280, height: 720 },
    ];
  }

  if (CPUS <= 2 || durationSec > 7200) return [{ name: "360p", width: 640, height: 360 }];
  if (CPUS <= 4 || durationSec > 3600) return [
    { name: "360p", width: 640, height: 360 },
    { name: "480p", width: 854, height: 480 },
  ];
  return [
    { name: "360p", width: 640, height: 360 },
    { name: "480p", width: 854, height: 480 },
    { name: "720p", width: 1280, height: 720 },
  ];
}

export default async function processJob(payload: TranscoderPayload, deliveryTag: string) {
  const { videoId, objectKey, correlationId, thumbnailKey } = payload;
  const start = Date.now();
  const ctx = { videoId, objectKey, correlationId, deliveryTag };

  logger.info(ctx, "Job started");

  let tmpDir: string | null = null;
  const uploadedKeys: string[] = [];
  const completedQualities: string[] = [];
  let success = false;

  try {
    tmpDir = await fs.mkdtemp(path.join(TMP, "tc-"));
    const inputPath = path.join(tmpDir, "input.mp4");

    await downloadSource(objectKey, inputPath);
    const stats = await fs.stat(inputPath);
    logger.info({ ...ctx, sizeMb: (stats.size / 1024 / 1024).toFixed(1) }, "Source downloaded");
    if (stats.size === 0) throw new Error("Empty file");

    const duration = await getVideoDuration(inputPath);
    const resolutions = getResolutions(duration);

    logger.info({ ...ctx, durationMin: (duration / 60).toFixed(1), resolutions: resolutions.map((r) => r.name) }, "Plan");

    // FIX 1: Generate & upload thumbnail first so the video has a cover poster the instant 360p goes live
    logger.info(ctx, "Generating video thumbnail upfront");
    await thumbnailGenAndUpload({ thumbnailKey: thumbnailKey ?? null, videoId, videoObjectKey: objectKey });

    // Step through each quality sequentially
    for (const res of resolutions) {
      const prodKey = `videos/${videoId}/${res.name}.mp4`;
      const outputPath = path.join(tmpDir, `${res.name}.mp4`);

      logger.info({ ...ctx, resolution: res.name }, "Transcoding");

      await transcode({
        inputPath,
        outputPath,
        output: res,
        timeoutMs: config.FFMPEG_TIMEOUT_MS || 1800000,
        durationSec: duration,
      });

      logger.info({ ...ctx, resolution: res.name }, "Uploading");
      await uploadFileWithRetry(outputPath, prodKey, videoId, res.name);
      
      uploadedKeys.push(prodKey);
      completedQualities.push(res.name);
      logger.info({ ...ctx, resolution: res.name }, "Done");

      // FIX 2: Notify backend to publish immediately with whatever qualities are ready right now
      // This changes the video status to ready for the user, appending newer streams live as they process.
      await notify(
        { 
          videoId, 
          status: "PUBLISHED", 
          qualities: [...completedQualities], 
          objectKey,
          isProcessingComplete: completedQualities.length === resolutions.length 
        },
        correlationId,
        deliveryTag,
        false // False ensures RabbitMQ doesn't prematurely drop our message thread channel
      ).catch((nErr) => logger.warn({ ...ctx, res: res.name, err: nErr.message }, "Incremental notification failed"));
    }

    // Flag job as fully verified to handle S3 source cleanups safely
    success = true;
    logger.info({ ...ctx, runtimeMin: ((Date.now() - start) / 60000).toFixed(1) }, "Completed");

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...ctx, err: msg, uploadedKeys }, "Failed");
    
    // Deletes whatever partial resolutions managed to hit S3 before the crash
    await cleanupPartialUploads(uploadedKeys, videoId);
    await notify({ videoId, error: msg }, correlationId, deliveryTag, true).catch(() => {});
    throw err;

  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    
    if (success) {
      await retry(
        () => s3.send(new DeleteObjectCommand({ Bucket: config.aws.S3_TEMP_BUCKET, Key: objectKey })),
        3,
        1000
      ).catch((e) => logger.error({ videoId, objectKey, err: e instanceof Error ? e.message : String(e) }, "Delete failed"));
    } else {
      logger.warn({ videoId, objectKey }, "Preserved temp source");
    }
  }
}
