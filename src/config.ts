import 'dotenv/config';
import pino from 'pino';


/**
 * Application configuration from environment variables
 * All S3 and messaging settings validated at startup
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
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/transcoder',
  FFMPEG_TIMEOUT_MS: parseInt(process.env.FFMPEG_TIMEOUT_MS || "1800000", 10),
  // NIMSY_API_SECRET:process.env.NIMSY_API_SECRET||'jwwfmwf49w4cww4c84w8gwhyj4sa4xab1dr8g4'
} as const;

/**
 * Structured JSON logger with service context
 * Uses pino-pretty in development for readable output
 */
export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: config.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
    : undefined,
  base: { service: 'nimsy-transcoder' },
}); 