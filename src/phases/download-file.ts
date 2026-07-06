import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { setTimeout as delay } from "node:timers/promises";
import { s3 } from "../s3.js";
import { config, logger } from "../config.js";
import { DownloadPayload, DownloadResult } from "../types.js";

// Partial download timeout (5 seconds for small source files)
const DOWNLOAD_TIMEOUT_MS = 5000;

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
      pipeline(
        prePareDownload.Body as NodeJS.ReadableStream,
        fs.createWriteStream(inputFile),
        { signal: ac.signal }
      ),
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
