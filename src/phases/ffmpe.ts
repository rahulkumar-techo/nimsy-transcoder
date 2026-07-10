import ffmpeg from "fluent-ffmpeg";
import { logger } from "../config.js";

// Use system ffmpeg path
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

export interface TranscodeOutput {
  name: string;
  width: number;
  height: number;
}

export interface TranscodeOptions {
  inputPath: string;
  outputPath: string;
  output: TranscodeOutput;
  timeoutMs: number;
  durationSec: number;
}

// FIX 1: Respect the engine overrides configured in docker-compose.yml
const HW_ACCEL_MODE = process.env.FFMPEG_HWACCEL || "cpu";
const IS_LOCAL = process.env.NODE_ENV !== "production";

export async function transcode({
  inputPath,
  outputPath,
  output,
  timeoutMs,
}: TranscodeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let isKilledByTimeout = false;

    const cmd = ffmpeg(inputPath)
      .output(outputPath)
      .audioCodec("aac")
      .size(`${output.width}x${output.height}`);

    // Determine the configuration matrix add in if  && HW_ACCEL_MODE === "gpu"
    if (IS_LOCAL&& HW_ACCEL_MODE === "gpu") {
    logger.info({ resolution: output.name }, "Configuring Intel QSV Hardware Accelerated Pipeline");

    cmd.videoCodec("h264_qsv");
    cmd.outputOptions([
      "-init_hw_device qsv=hw",  // FIX 2: Force explicit hardware initialization for Docker containers
      "-preset veryfast",       // Ultra-fast hardware slice execution
      "-global_quality 23",     // QSV constant quality (Equivalent to CRF 23)
      "-movflags +faststart",   // Shift index data to the front for web streaming
    ]);
  } else {
    // Fallback or Production Path
    const targetPreset = IS_LOCAL ? "-preset ultrafast" : "-preset veryfast";
    logger.info({ resolution: output.name, preset: targetPreset }, "Configuring High-Efficiency CPU Encoder");

    cmd.videoCodec("libx264");
    cmd.outputOptions([
      targetPreset,
      "-movflags +faststart",
      "-threads 2"              // FIX 3: Pins execution threads to stay stable under Docker Compose resource limits
    ]);
  }

  // Set up failsafe system timeout monitor
  const timer = setTimeout(() => {
    isKilledByTimeout = true;
    cmd.kill("SIGKILL");
    reject(new Error(`FFmpeg processing timeout hit at ${timeoutMs}ms`));
  }, timeoutMs);

  cmd
    .on("start", (cli) => {
      logger.info({ resolution: output.name, cli }, "FFmpeg processing initiated");
    })
    .on("progress", (p) => {
      logger.debug(
        {
          resolution: output.name,
          percent: p.percent?.toFixed(1) ?? "0.0",
          fps: p.currentFps,
          frame: p.frames,
          timemark: p.timemark,
        },
        "FFmpeg transcoding progress"
      );
    })
    .on("end", () => {
      clearTimeout(timer);
      logger.info({ resolution: output.name }, "FFmpeg transcode stream complete");
      resolve();
    })
    .on("error", (err, _stdout, stderr) => {
      clearTimeout(timer);

      // Prevent bubble errors if the job was intentionally destroyed by the system timeout
      if (isKilledByTimeout) return;

      logger.error(
        {
          resolution: output.name,
          err: err.message,
          stderr: stderr || "No standard error dump captured"
        },
        "FFmpeg worker pipeline crashed"
      );
      reject(err);
    })
    .run();
});
}
