import { NodeHttpHandler } from "@smithy/node-http-handler";
import { S3Client } from "@aws-sdk/client-s3";
import { Agent } from "node:https";
import { config } from "./config.js";

// Shared S3 client used by download, upload, and cleanup.
//
// Key settings:
// - timeoutMs: overall request/connection timeout from the HTTP handler.
// - family: 4 forces IPv4 only. Fixes ETIMEDOUT/ENETUNREACH when IPv6 is
//           unavailable in the container/host.
// - keepAlive/maxSockets: reuse TCP connections for multiple S3 calls per job.
export const s3 = new S3Client({
  region: config.aws.AWS_REGION,
  credentials: {
    accessKeyId: config.aws.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.aws.AWS_SECRET_ACCESS_KEY,
  },
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 30_000,
    requestTimeout: 300_000,
    httpsAgent: new Agent({
      keepAlive: true,
      maxSockets: 50,
      family: 4,
    }),
  }),
});
