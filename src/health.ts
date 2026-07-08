import Fastify from "fastify";
import { logger } from "./config.js";
import { isConsumerStarted } from "./queue.js";

export function createHealthServer(port: number = 5001) {
  const server = Fastify({ logger: false });

  server.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  server.get("/health/ready", async (_request, reply) => {
    const ready = isConsumerStarted();
    if (!ready) {
      return reply.status(503).send({
        status: "not ready",
        reason: "RabbitMQ consumer not started",
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: "ready",
      timestamp: new Date().toISOString(),
    };
  });

  server.get("/health/metrics", async () => ({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    rabbitmqReady: isConsumerStarted(),
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