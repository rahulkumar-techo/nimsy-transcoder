import { CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3"
import { config } from "../config.js"
import { s3 } from "../s3.js"

export const thumbnailGenAndUpload = async (payload: { thumbnailKey: string | null }) => {
    // also upload Thumbanil to production 
    if (payload.thumbnailKey) {
        await Promise.all([
            s3.send(
                new CopyObjectCommand({
                    Bucket: config.aws.S3_PROD_BUCKET, // destination
                    CopySource: `${config.aws.S3_TEMP_BUCKET}/${encodeURIComponent(payload?.thumbnailKey)}`,
                    Key: payload?.thumbnailKey,
                }),

            ),
            // remove from temp bucket after successful copy
            s3.send(
                new DeleteObjectCommand({
                    Bucket: config.aws.S3_TEMP_BUCKET,
                    Key: payload?.thumbnailKey,
                }),
            )
        ])
    }

    else {
        // Generate Thumbanil and then upload
    }

}