// 13. Replace Partial<PublishedPayload> with specific notification types


// FIX: CompletedNotification now matches the backend PublishedPayload schema exactly.
// Backend expects: { videoId, status: "PUBLISHED", qualities[], objectKey }
// Previously this sent lowercase "completed" and missing objectKey, causing Zod validation failure.
export interface CompletedNotification {
  videoId: string;
  status: "PUBLISHED";
  qualities: string[];
  objectKey: string;
}

// FIX: FailedNotification now matches the backend FailedSchema exactly.
// Backend expects: { videoId, error }
// Previously this sent extra fields (status, qualities, uploadedKeys) that were irrelevant.
export interface FailedNotification {
  videoId: string;
  error: string;
}

// FIX: TranscoderPayload was removed in a previous edit but is still imported by job.ts.
// This is the message payload consumed from RabbitMQ.
export interface TranscoderPayload {
  videoId: string;
  objectKey: string;
  correlationId: string;
  deliveryTag: string;
  thumbnailKey?: string;
}

// =====================>

// for logging
interface baseContext {
  videoId: string;
  objectKey: string;
  correlationId: string;
  deliveryTag: string;
}

export interface DownloadPayload {
  objectKey: string;
  inputFile: string;
  baseContext: baseContext;
}

export interface DownloadResult {
  inputFile: string;
  durationMs: number;
  sizeBytes: number;
}
