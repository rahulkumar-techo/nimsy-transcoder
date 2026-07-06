import { config, logger } from "../config.js";
import { CompletedNotification, FailedNotification } from "../types.js";
import { retry } from "./retry.js";





// 5. Fetch with timeout using AbortController
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// 5, 16. Notification with retry, timeout, and full context
// FIX: notify now routes failures to /internal/transcoded/failed and successes to /internal/transcoded.
// Previously both used /internal/transcoded, causing the backend failure endpoint to never be hit.
export async function notify(
  payload: CompletedNotification | FailedNotification,
  correlationId: string,
  deliveryTag: string,
  isFailure = false
): Promise<void> {
  const { videoId } = payload;
  const context = { videoId, correlationId, deliveryTag };

  const endpoint = isFailure ? "/internal/transcoded/failed" : "/internal/transcoded";

  await retry(
    async () => {
      logger.info(context, "Sending notification");
      const res = await fetchWithTimeout(
        `${config.API_URL}${endpoint}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.API_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        15000 // 15 second timeout
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      logger.info(context, "Notification sent");
    },
    3,
    1000,
    // context
  );
}
