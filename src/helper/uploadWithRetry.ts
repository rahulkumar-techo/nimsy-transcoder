import { Upload } from "@aws-sdk/lib-storage";
import { logger } from "../config.js";
import { retry } from "./retry.js";
import fs from "node:fs";
import { s3 } from "../s3.js";


// 10. Throttled upload progress logger
function createProgressLogger(videoId: string, resolution: string, key: string) {
  let lastLoggedPercent = -1;
  const logInterval = 10; // Log every 10%

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


// 14, 15. S3 upload with retry, throttled progress, and connection reuse
export async function uploadWithRetry(
  bucket: string,
  key: string,
  file: string,
  contentType: string,
  resolutionName: string,
  videoId: string
): Promise<void> {
  const context = { videoId, resolution: resolutionName, bucket, key };

  await retry(
    async () => {
      logger.info(context, "Upload started");

      const stream = fs.createReadStream(file);

      try {
        const uploader = new Upload({
          client: s3,
          params: {
            Bucket: bucket,
            Key: key,
            Body: stream,
            ContentType: contentType,
          },
          partSize: 8 * 1024 * 1024,
          queueSize: 2,
          leavePartsOnError: false,
        });

        uploader.on(
          "httpUploadProgress",
          createProgressLogger(videoId, resolutionName, key)
        );

        await uploader.done();

        logger.info(context, "Upload completed");
      } finally {
        stream.destroy();
      }
    },
    3,
    2000,
    // context
  );
}