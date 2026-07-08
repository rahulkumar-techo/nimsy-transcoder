import amqplib, { ConsumeMessage } from "amqplib";
import { config, logger } from "./config.js";
import { retry } from "./helper/retry.js";
import jobProcess from "./job.js";

// RabbitMQ topology for transcoder jobs.
// Expected routing:
//   backend publish -> direct exchange -> transcode queue -> this consumer
const TRANSCODER = {
  exchange: "transcode_exchange",
  routingKey: "transcode_routingKey",
  queue: "transcode",
} as const;

let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;
// Used by /health/ready so the service reports not-ready until RabbitMQ is connected.
let consumerStarted = false;

// Establish RabbitMQ connection and start consuming.
// Uses retry() so startup does not fail permanently if the broker is briefly down.
// Example retry behavior:
//   attempt 1 -> fail
//   wait 2s
//   attempt 2 -> success -> prefetch(1) -> consume
export async function transcodeConsumer() {
  await retry(async () => {
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
    // 10s TCP/TLS timeout prevents hanging if the broker is unreachable.
    connection = await amqplib.connect(config.RABBITMQ_URL, {
      timeout: 10000,
    });

    channel = await connection.createChannel();

    await channel.assertExchange(TRANSCODER.exchange, "direct", {
      durable: true,
    });

    await channel.assertQueue(TRANSCODER.queue, {
      durable: true,
    });

    await channel.bindQueue(
      TRANSCODER.queue,
      TRANSCODER.exchange,
      TRANSCODER.routingKey,
    );

    // Only one unacked job per consumer. Heavy 10GB jobs should not pile up
    // in one container. For parallelism, run multiple containers/replicas.
    await channel.prefetch(1);

    await channel.consume(TRANSCODER.queue, onMessage);

    consumerStarted = true;
    logger.info("Transcoder consumer started");
  }, 10, 2000);
}

export function isConsumerStarted() {
  return consumerStarted;
}

// Handle one RabbitMQ message.
// Payload example:
//   {
//     videoId: "759dbed8-daad-4ba9-bb80-93b6045f3ef6",
//     objectKey: "videos/759dbed8-.../original.mp4",
//     correlationId: "c1",
//     deliveryTag: 1,
//     thumbnailKey: null
//   }
async function onMessage(msg: ConsumeMessage | null) {
  if (!msg || !channel) return;

  try {
    await jobProcess(JSON.parse(msg.content.toString()));

    channel.ack(msg);
  } catch (err) {
    logger.error({ err }, "Transcoding failed");
    // Requeue=false, multiple=false -> drop to DLQ or discard after retries.
    channel.nack(msg, false, false);
  }
}

// Graceful shutdown helper.
export async function close() {
  consumerStarted = false;
  try { await channel?.close(); } catch { /* ignore */ }
  try { await connection?.close(); } catch { /* ignore */ }
  channel = null;
  connection = null;
}
