import 'dotenv/config';
import pino from 'pino';

/**
 * Application configuration from environment variables.
 *
 * Key env vars:
 * - TEMP_DIR / TMPDIR: local working directory for downloads/encodes
 *   Example: TEMP_DIR=/mnt/fast-storage/transcoder
 * - FFMPEG_TIMEOUT_MS: max transcode duration in ms
 *   Example: FFMPEG_TIMEOUT_MS=7200000 -> 2 hours for large files
 * - DOWNLOAD_TIMEOUT_MS: max single download duration in ms
 *   Example: DOWNLOAD_TIMEOUT_MS=120000 -> 120 seconds
 * - RABBITMQ_URL: AMQP/AMQPS broker URL
 *   Example: amqp://user:pass@rabbitmq:5672 or amqps://...
 *
 * AWS settings:
 * - AWS_REGION
 * - S3_TEMP_BUCKET/S3_PRODUCTION_BUCKET
 * - AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
 *
 * Internal notification:
 * - INTERNAL_API_URL
 * - NIMSY_API_SECRET
 */
export const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  RABBITMQ_URL: process.env.RABBITMQ_URL!,
  aws: {
    AWS_REGION: process.env.AWS_REGION!,
    S3_TEMP_BUCKET: process.env.S3_TEMP_BUCKET!,
    S3_PROD_BUCKET: process.env.S3_PRODUCTION_BUCKET!,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID!,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY!
  },
  API_URL: process.env.INTERNAL_API_URL!,
  API_SECRET: process.env.NIMSY_API_SECRET!,
  // Prefer TEMP_DIR, then TMPDIR, then fallback.
  // This is where source files and encoded outputs are written.
  TEMP_DIR: process.env.TEMP_DIR || process.env.TMPDIR || '/tmp/transcoder',
  // Default 30 minutes; override for very large videos.
  FFMPEG_TIMEOUT_MS: parseInt(process.env.FFMPEG_TIMEOUT_MS || "1800000", 10),
} as const;

/**
 * Structured JSON logger with service context.
 * Uses pino-pretty in development for readable output.
 * Example log line:
 *   {"level":30,"service":"nimsy-transcoder","msg":"Job started","videoId":"..."}
 */
export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: config.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
    : undefined,
  base: { service: 'nimsy-transcoder' },
});
