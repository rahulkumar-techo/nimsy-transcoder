import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { s3 } from "../s3.js";
import { config } from "../config.js";

export async function uploadFile(filePath: string, key: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.aws.S3_PROD_BUCKET,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: "video/mp4",
    })
  );
}