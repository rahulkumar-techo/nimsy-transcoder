import { inspect } from "node:util";
import { logger } from "../config.js";


// 4. Generic retry helper
export async function retry<T>(
  operation: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  // context: Record<string, unknown>
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      // const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn({
        attempt,
        error: inspect(err, { depth: null }),
      });
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, attempt * baseDelayMs));
    }
  }
  throw new Error("Unreachable");
}

