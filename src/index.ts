import { logger } from "./config.js";
import { createHealthServer } from "./health.js";
import { close, transcodeConsumer } from "./queue.js";

const healthServer = createHealthServer(5001);

let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;

  logger.info({ signal }, "Shutting down");

  await Promise.allSettled([close(), healthServer.stop()]);

  logger.info("Shutdown complete");
  process.exit(0);
};
 
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

async function start() {
  try {
    logger.info("Starting transcoder");

    await healthServer.start();
    await transcodeConsumer();

    logger.info("Transcoder ready");
  } catch (err) {
    logger.fatal({ err }, "Startup failed");
    process.exit(1);
  }
}

void start();