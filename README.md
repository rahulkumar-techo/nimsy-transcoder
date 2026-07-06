# 🎬 Nimsy Transcoder

A dedicated video transcoding microservice for the Nimsy platform. Consumes source videos from S3, transcodes them to multiple resolutions using FFmpeg, uploads outputs to production storage, and notifies the backend via API.

---

## ✨ Features

* RabbitMQ-based job queue with prefetch=1
* Multi-resolution transcoding: 240p, 360p, 480p, 720p
* FFmpeg pipeline with libx264/aac, CRF 23, and `faststart` for web playback
* Multipart S3 upload with retry and throttled progress logging
* Automatic cleanup of partial uploads on failure
* Thumbnail copy/generation support
* Health check endpoints for container orchestration
* Structured JSON logging with pino

---

## 🏗️ Tech Stack

| Component       | Technology                     |
| --------------- | ------------------------------ |
| Runtime         | Node.js 22+                    |
| Transcoding     | FFmpeg + fluent-ffmpeg         |
| Queue           | RabbitMQ (amqplib)             |
| Storage         | AWS S3                         |
| HTTP Client     | Node.js native fetch           |
| Logging         | pino + pino-pretty             |
| Health          | Fastify                        |
| Testing         | Vitest                         |
| Language        | TypeScript                     |

---

## 📂 Project Structure

```text
src/
├── config.ts           # Environment configuration and logger
├── s3.ts               # AWS S3 client with keep-alive agent
├── health.ts           # Health check server
├── queue.ts            # RabbitMQ consumer and shutdown
├── job.ts              # Orchestrator: download → transcode → upload → notify
├── types.ts            # TypeScript interfaces
├── phases/
│   ├── download-file.ts    # S3 download with timeout
│   ├── ffmpe.ts            # FFmpeg transcoding wrapper
│   └── thumbnail.ts        # Thumbnail copy/generation
└── helper/
    ├── retry.ts            # Generic retry helper
    ├── uploadWithRetry.ts  # Multipart S3 upload
    ├── cleanupPartialUploads.ts
    └── notify.ts           # Backend notification
```

---

## 🔁 Transcoding Pipeline

```text
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────────┐
│  RabbitMQ   │────▶│   Download   │────▶│   Transcode  │────▶│    Upload     │────▶│   Notify Backend │
│  Job Queue  │     │  from S3     │     │  (4 res.)    │     │  to S3 Prod   │     │   via HTTP       │
└─────────────┘     └──────────────┘     └──────────────┘     └───────────────┘     └──────────────────┘
```

1. **Consume** — Job received from the `transcode_exchange`
2. **Download** — Source file fetched from the temp S3 bucket
3. **Transcode** — FFmpeg generates 240p / 360p / 480p / 720p MP4 files
4. **Upload** — Each resolution uploaded to the production S3 bucket
5. **Thumbnail** — Existing thumbnail copied or generated
6. **Notify** — Backend receives `POST /internal/transcoded` on success, or `/internal/transcoded/failed` on failure

---

## 🚀 Getting Started

### Prerequisites

* Node.js >= 22.0.0
* FFmpeg binary (provided by `ffmpeg-static`)
* RabbitMQ server
* AWS S3 buckets (temp and production)

### Installation

```bash
npm install
```

### Environment Setup

Create a `.env` file:

```env
NODE_ENV=development
RABBITMQ_URL=amqp://localhost:5672
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
S3_TEMP_BUCKET=your-temp-bucket
S3_PRODUCTION_BUCKET=your-production-bucket
INTERNAL_API_URL=http://localhost:5000
NIMSY_API_SECRET=your_api_secret
TEMP_DIR=/tmp/transcoder
FFMPEG_TIMEOUT_MS=1800000
```

### Scripts

```bash
# Start development server with watch
npm run dev

# Build TypeScript
npm run build

# Start production server
npm run start

# Run tests
npm run test
```

---

## 🏥 Health Check

| Endpoint        | Port  | Description               |
| --------------- | ----- | ------------------------- |
| `/health/live`  | 5001  | Liveness probe            |
| `/health/ready` | 5001  | Readiness probe           |
| `/health/metrics` | 5001 | Uptime and memory metrics |

---

## 📡 Notifications

On success:

```http
POST /internal/transcoded
Authorization: Bearer <NIMSY_API_SECRET>
Content-Type: application/json

{
  "videoId": "abc-123",
  "status": "PUBLISHED",
  "qualities": ["240p", "360p", "480p", "720p"],
  "objectKey": "uploads/original.mp4"
}
```

On failure:

```http
POST /internal/transcoded/failed
Authorization: Bearer <NIMSY_API_SECRET>
Content-Type: application/json

{
  "videoId": "abc-123",
  "error": "Transcode timeout after 1800000ms"
}
```

---

## 🔐 Security

* Internal API calls authenticated via bearer token
* S3 credentials sourced from environment variables only
* Partial uploads automatically cleaned up on job failure
* Temp source files retained on failure for retry/troubleshooting

---

## 🎯 Design Principles

* Sequential job processing (prefetch=1) to prevent resource exhaustion
* Automatic retries with linear backoff for network operations
* Graceful shutdown with message nack on SIGTERM/SIGINT
* Local temp directories per job with guaranteed cleanup in `finally`

---

# 📄 License

Private Project — Nimsy Team.
