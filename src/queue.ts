import amqplib, { ConsumeMessage } from "amqplib";
import { config, logger } from "./config.js";
import jobProcess from "./job.js";

const TRANSCODER = {
  exchange: "transcode_exchange",
  routingKey: "transcode_routingKey",
  queue: "transcode",
} as const;

let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;

export async function transcodeConsumer() {
  connection = await amqplib.connect(config.RABBITMQ_URL);

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

  await channel.prefetch(1);

  await channel.consume(TRANSCODER.queue, onMessage);

  logger.info("Transcoder consumer started");
}

async function onMessage(msg: ConsumeMessage | null) {
  if (!msg || !channel) return;

  try {
    await jobProcess(JSON.parse(msg.content.toString()));
    
    channel.ack(msg);
  } catch (err) {
    logger.error({ err }, "Transcoding failed");
    channel.nack(msg, false, false);
  }
}

export async function close() {
  await channel?.close();
  await connection?.close();
}