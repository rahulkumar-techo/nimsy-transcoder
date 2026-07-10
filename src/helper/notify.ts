import { config, logger } from "../config.js";
import { retry } from "./retry.js";

// Explicitly type payloads to support real-time streaming updates
export interface IncrementalProgressPayload {
  videoId: string;
  status: "PUBLISHED";
  qualities: string[];
  objectKey: string;
  isProcessingComplete: boolean;
}

export interface FailurePayload {
  videoId: string;
  error: string;
}

// Fetch with a failsafe system abort configuration controller
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatches real-time pipeline status updates directly to the core API Server cluster.
 * 
 * NOTE: System-level RabbitMQ message ACK / NACK management must be maintained strictly 
 * by the core orchestrator script once this loop resolves or catches a terminal error.
 */
export async function notify(
  payload: IncrementalProgressPayload | FailurePayload,
  correlationId: string,
  deliveryTag: string,
  isFailure = false
): Promise<void> {
  const { videoId } = payload;
  const context = { videoId, correlationId, deliveryTag, isFailure };

  // Explicitly direct networking paths to match production cluster structures
  const endpoint = isFailure ? "/internal/transcoded/failed" : "/internal/transcoded";
  const targetUrl = `${config.API_URL}${endpoint}`;

  await retry(
    async () => {
      logger.info(
        { ...context, targetUrl }, 
        isFailure ? "Dispatching job failure traceback" : "Dispatching real-time resolution update"
      );

      const res = await fetchWithTimeout(
        targetUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.API_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        15000 // 15-second network timeout block threshold
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "Could not extract error response body");
        throw new Error(`HTTP Error status ${res.status}: ${text}`);
      }

      logger.info(context, "State notification synchronization successful");
    },
    3,    // Maximum of 3 network connection retry loops
    1000  // 1-second base delay backoff frequency metric
  );
}
