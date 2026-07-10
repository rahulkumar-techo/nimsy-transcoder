import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { config, logger } from "../config.js";
import { retry } from "../helper/retry.js";
import { s3 } from "../s3.js";

/**
 * Upload a local file to S3 with multipart upload, retry, and throttled progress logging.
 */
export async function uploadFileWithRetry(
  filePath: string,
  key: string,
  videoId: string,
  resolutionName: string
): Promise<void> {
  const context = { videoId, resolution: resolutionName, key };

  await retry(
    async () => {
      logger.info(context, "Upload started");

      const stream = createReadStream(filePath);

      try {
        const uploader = new Upload({
          client: s3,
          params: {
            Bucket: config.aws.S3_PROD_BUCKET,
            Key: key,
            Body: stream,
            ContentType: "video/mp4",
          },
          partSize: 8 * 1024 * 1024,   // 8 MB chunks.
          queueSize: 2,                // 2 concurrent uploads max.
          leavePartsOnError: false,    // Clean up failed multipart parts.
        });

        uploader.on("httpUploadProgress", createProgressLogger(videoId, resolutionName, key));

        await uploader.done();

        logger.info(context, "Upload completed");
      } finally {
        stream.destroy(); // Ensure fd is closed even on error.
      }
    },
    3,      // Max 3 attempts.
    2000    // 2 second base delay between retries.
  );
}

/** Throttled progress logger — logs every 10% to avoid spam. */
function createProgressLogger(videoId: string, resolution: string, key: string) {
  let lastLoggedPercent = -1;
  const logInterval = 10; // Log every 10%.

  return (progress: { loaded?: number; total?: number }) => {
    if (!progress.total || progress.total === 0 || progress.loaded == null) return;

    const percent = Math.floor((progress.loaded / progress.total) * 100);
    if (percent >= lastLoggedPercent + logInterval) {
      lastLoggedPercent = percent;
      logger.info(
        { videoId, resolution, key, percent, loaded: progress.loaded, total: progress.total },
        "Upload progress"
      );
    }
  };
}