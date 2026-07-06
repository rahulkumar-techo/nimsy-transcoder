import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config, logger } from "../config.js";
import { s3 } from "../s3.js";

// 8. Cleanup partial uploads from S3
export async function cleanupPartialUploads(uploadedKeys: string[], videoId: string): Promise<void> {
  if (uploadedKeys.length === 0) return;

  logger.info({ videoId, keys: uploadedKeys }, "Cleaning up partial uploads");

  for (const key of uploadedKeys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.aws.S3_PROD_BUCKET, Key: key }));
      logger.info({ videoId, key }, "Deleted partial upload");
    } catch (err) {
      logger.error(
        { videoId, key, err: err instanceof Error ? err.message : String(err) },
        "Failed to delete partial upload"
      );
    }
  }
}