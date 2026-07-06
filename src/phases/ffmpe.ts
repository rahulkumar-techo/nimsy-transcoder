import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

import { logger } from "../config.js";

if (typeof ffmpegPath !== "string") {
  throw new Error("FFmpeg binary not found.");
}

ffmpeg.setFfmpegPath(ffmpegPath);

export interface TranscodeOptions {
  input: string;
  output: string;
  width: number;
  height: number;
  timeoutMs: number;
}

export const transcode = ({
  input,
  output,
  width,
  height,
  timeoutMs,
}: TranscodeOptions): Promise<void> =>
  new Promise((res, rej) => {
    const command = ffmpeg(input)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-vf",
        `scale=${width}:${height}`,
        "-preset",
        "fast",
        "-crf",
        "23",
        "-movflags",
        "+faststart",
      ])
      .output(output);

    const timer = setTimeout(() => {
      command.kill("SIGKILL");
      rej(new Error(`Transcode timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    command
      .once("end", () => {
        clearTimeout(timer);
        res();
      })
      .once("error", (err) => {
        clearTimeout(timer);
        rej(err);
      })
      .on("start", (commandLine) => {
        logger.debug({ commandLine }, "FFmpeg started");
      })
      .on("progress", (progress) => {
        logger.debug(
          {
            percent: progress.percent ? Math.floor(progress.percent) : undefined,
            currentFps: progress.currentFps,
            currentKbps: progress.currentKbps,
          },
          "FFmpeg progress"
        );
      })
      .run();
  });
