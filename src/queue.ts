import amqplib, { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { config, logger } from "./config.js";
import { retry } from "./helper/retry.js";
import jobProcess from "./job.js";

const TOPOLOGY = {
  exchange: "transcode_exchange",
  routingKey: "transcode_routingKey",
  queue: "transcode",
  dlqExchange: "transcode_dlx_exchange",
  dlqQueue: "transcode_dead_letter",
  dlqRoutingKey: "dead_letter_key",
} as const;

const CONSUMER_OPTS = {
  prefetch: 1,
  maxRetries: 3,
} as const;

const RETRY_OPTS = {
  maxAttempts: 10,
  baseDelayMs: 2000,
} as const;

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let consumerStarted = false;

export function isConsumerStarted(): boolean {
  return consumerStarted;
}

export async function transcodeConsumer(): Promise<void> {
  await retry(async () => {
    await teardown();

    connection = await amqplib.connect(config.RABBITMQ_URL, { timeout: 10000 });
    connection.on("error", (err) => {
      logger.warn({ err: err.message }, "Transcoder connection error");
    });

    channel = await connection.createChannel();
    channel.on("error", (err) => {
      logger.warn({ err: err.message }, "Transcoder channel error");
    });

    await setupTopology(channel);

    await channel.prefetch(CONSUMER_OPTS.prefetch);
    await channel.consume(TOPOLOGY.queue, onMessage);

    consumerStarted = true;
    logger.info("Transcoder consumer initialized");
  }, RETRY_OPTS.maxAttempts, RETRY_OPTS.baseDelayMs);
}

async function setupTopology(ch: Channel): Promise<void> {
  // 1. DLX infrastructure
  await ch.assertExchange(TOPOLOGY.dlqExchange, "direct", { durable: true });
  await ch.assertQueue(TOPOLOGY.dlqQueue, { durable: true });
  await ch.bindQueue(TOPOLOGY.dlqQueue, TOPOLOGY.dlqExchange, TOPOLOGY.dlqRoutingKey);

  // 2. Main exchange
  await ch.assertExchange(TOPOLOGY.exchange, "direct", { durable: true });

  // 3. Main queue (with automatic recovery from 406 mismatches)
  await assertTranscodeQueue(ch);
}

async function assertTranscodeQueue(ch: Channel): Promise<void> {
  const args = {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": TOPOLOGY.dlqExchange,
      "x-dead-letter-routing-key": TOPOLOGY.dlqRoutingKey,
    },
  };

  try {
    await ch.assertQueue(TOPOLOGY.queue, args);
  } catch (err) {
    if (!isPreconditionFailed(err) || !connection) throw err;

    logger.warn(
      { queue: TOPOLOGY.queue },
      "Queue exists with incompatible arguments; recreating with DLX topology"
    );

    // Channel is dead after 406; use a fresh one
    const fresh = await connection.createChannel();
    fresh.on("error", (e) => {
      logger.warn({ err: e.message }, "Transcoder channel error");
    });

    await fresh.deleteQueue(TOPOLOGY.queue).catch(() => {
      /* queue may already be gone */
    });
    await fresh.assertQueue(TOPOLOGY.queue, args);

    // Promote fresh channel so subsequent operations use it
    channel = fresh;
  }

  // Always bind on the channel that successfully asserted the queue
  const active = channel ?? ch;
  await active.bindQueue(TOPOLOGY.queue, TOPOLOGY.exchange, TOPOLOGY.routingKey);
}

function isPreconditionFailed(err: unknown): err is { code: 406 } {
  
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === 406;
}

async function onMessage(msg: ConsumeMessage | null): Promise<void> {
  if (!msg || !channel) return;

  const deathCount = msg.properties.headers?.["x-death"]?.[0]?.count ?? 0;
  const payload = parsePayload(msg);

  try {
    if (deathCount >= CONSUMER_OPTS.maxRetries) {
      logger.error(
        { deliveryTag: msg.fields.deliveryTag, deathCount },
        "Message exceeded max retries; sending to DLQ"
      );
      channel.nack(msg, false, false);
      return;
    }

    await jobProcess(payload as any, String(msg.fields.deliveryTag));
    channel.ack(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, deathCount }, "Transcoding failed");

    const shouldRequeue = deathCount < CONSUMER_OPTS.maxRetries - 1;
    if (shouldRequeue) {
      logger.warn({ deliveryTag: msg.fields.deliveryTag }, "Requeuing for retry");
      channel.nack(msg, false, true);
    } else {
      channel.nack(msg, false, false);
    }
  } 
}

function parsePayload(msg: ConsumeMessage): unknown {
  try {
    return JSON.parse(msg.content.toString());
  } catch {
    throw new Error("Invalid JSON in message body");
  }
}

export async function close(): Promise<void> {
  consumerStarted = false;
  await teardown();
}

async function teardown(): Promise<void> {
  if (channel) {
    try { await channel.close(); } catch { /* ignore */ }
    channel = null;
  }
  if (connection) {
    try { await connection.close(); } catch { /* ignore */ }
    connection = null;
  }
}