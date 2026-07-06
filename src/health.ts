import Fastify from "fastify";
import { logger } from "./config.js";


/**
 * Health check server for container orchestration
 * Provides liveness and readiness endpoints
 */
export function createHealthServer(port: number = 5001) {
  const server = Fastify({ logger: false });

  // Liveness check - is the process running?
  server.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // Readiness check - can we process jobs?
  server.get("/health/ready", async () => ({
    status: "ready",
    timestamp: new Date().toISOString(),
  }));

  // Metrics endpoint
  server.get("/health/metrics", async () => ({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    circuitBreakers: {
    },
  }));

  const start = async () => {
    try {
      await server.listen({ port, host: "0.0.0.0" });
      logger.info(`Health check server listening on port ${port}`);
    } catch (err) {
      logger.error({ err }, "Failed to start health server");
    }
  };

  const stop = async () => {
    await server.close();
  };

  return { start, stop };
}