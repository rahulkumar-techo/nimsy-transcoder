FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

ENV TMPDIR=/tmp/transcoder

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

EXPOSE 5001

CMD ["node", "dist/index.js"]
