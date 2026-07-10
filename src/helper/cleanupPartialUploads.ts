import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config, logger } from "../config.js";
import { s3 } from "../s3.js";

/**
 * Delete partially uploaded renditions from S3 after a job failure.
 * Prevents orphaned files from cluttering the prod bucket.
 */
export async function cleanupPartialUploads(uploadedKeys: string[], videoId: string): Promise<void> {
  if (uploadedKeys.length === 0) return;

  logger.info({ videoId, count: uploadedKeys.length }, "Cleaning up partial uploads");

  // Fire all deletes in parallel — they're independent, no point serializing.
  const results = await Promise.allSettled(
    uploadedKeys.map((key) => deleteOne(key, videoId))
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn({ videoId, failedCount: failed.length }, "Some partial uploads could not be deleted");
  }
}

/** Delete a single S3 object, log the outcome. */
async function deleteOne(key: string, videoId: string): Promise<void> {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: config.aws.S3_PROD_BUCKET,
        Key: key,
      })
    );
    logger.debug({ videoId, key }, "Deleted partial upload");
  } catch (err) {
    logger.error(
      { videoId, key, err: err instanceof Error ? err.message : String(err) },
      "Failed to delete partial upload"
    );
    throw err; // Re-throw so Promise.allSettled marks it rejected.
  }
}

/*
| Before                          | After                                   |
| ------------------------------- | --------------------------------------- |
| Serial `for...of` loop          | `Promise.allSettled` — parallel deletes |
| `logger.info` for every success | `logger.debug` — less noise             |
| No summary of failures          | Logs how many deletions failed          |
| Inline error handling           | Extracted to `deleteOne` helper         |

*/ 