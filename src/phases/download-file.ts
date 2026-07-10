import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { s3 } from "../s3.js";
import { config, logger } from "../config.js";

const STALL_TIMEOUT_MS = 2 * 60 * 1000;

export async function downloadSource(objectKey: string, destPath: string): Promise<void> {
  logger.info({ objectKey }, "Downloading source");

  const { Body } = await s3.send(
    new GetObjectCommand({
      Bucket: config.aws.S3_TEMP_BUCKET,
      Key: objectKey,
    })
  );

  if (!Body) {
    throw new Error(`Empty S3 body for key: ${objectKey}`);
  }

  const stream = Body as NodeJS.ReadableStream;
  let lastByteTime = Date.now();

  stream.on("data", () => {
    lastByteTime = Date.now();
  });

  const stallCheck = new Promise<never>((_, reject) => {
    const interval = setInterval(() => {
      if (Date.now() - lastByteTime > STALL_TIMEOUT_MS) {
        clearInterval(interval);
        reject(new Error(`Download stalled: no data for ${STALL_TIMEOUT_MS / 1000}s`));
      }
    }, 10000);
  });

  await Promise.race([pipeline(stream, createWriteStream(destPath)), stallCheck]);
}