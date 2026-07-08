import { execSync, spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

import { logger } from "../config.js";

// Prefer system-installed ffmpeg, then ffmpeg-static, then FFMPEG_PATH env.
// Example:
//   FFMPEG_PATH=/usr/local/bin/ffmpeg node dist/index.js
//   apk add --no-cache ffmpeg  -> resolves to /usr/bin/ffmpeg
let resolvedFfmpeg: string | null = null;

try {
  resolvedFfmpeg = process.env.FFMPEG_PATH ?? execSync("command -v ffmpeg", {
    encoding: "utf8",
  }).trim();
} catch {
  if (typeof ffmpegPath === "string") {
    resolvedFfmpeg = ffmpegPath;
  }
}

if (!resolvedFfmpeg) {
  throw new Error("FFmpeg binary not found.");
}

// Describes one rendition to generate.
// Example:
//   { name: "720p", width: 1280, height: 720, path: "/tmp/.../720p.mp4" }
export interface TranscodeOutput {
  name: string;
  path: string;
  width: number;
  height: number;
}

export interface TranscodeOptions {
  input: string;
  // Example:
  // outputs = [
  //   { name: "240p", width: 426, height: 240, path: "/tmp/.../240p.mp4" },
  //   { name: "720p", width: 1280, height: 720, path: "/tmp/.../720p.mp4" }
  // ]
  outputs: readonly TranscodeOutput[];
  timeoutMs: number;
}

export interface TranscodeResult {
  outputs: Array<{ name: string; path: string }>;
}

// Build a single ffmpeg filter_complex string that decodes once and scales
// into N outputs. This avoids decoding the source file N times.
// 
// Example for 240p + 720p:
//   [0:v]split=2[v0][v1];[v0]scale=426:240[v0out];[v1]scale=1280:720[v1out]
function buildFilterComplex(outputs: readonly TranscodeOutput[]): string {
  const numOutputs = outputs.length;
  // Temporary labels after split: v0, v1, v2, ...
  const splitLabels = Array.from({ length: numOutputs }, (_, i) => `v${i}`);
  // Final labels after scale: v0out, v1out, v2out, ...
  const scaleOutLabels = Array.from({ length: numOutputs }, (_, i) => `v${i}out`);

  const parts: string[] = [];

  // Split the video stream into N identical branches.
  parts.push(
    `[0:v]split=${numOutputs}${splitLabels.map((label) => `[${label}]`).join("")}`
  );

  // Scale each branch to its target resolution.
  // Example: [v0]scale=426:240[v0out]
  for (let i = 0; i < numOutputs; i++) {
    parts.push(
      `[${splitLabels[i]}]scale=${outputs[i].width}:${outputs[i].height}[${scaleOutLabels[i]}]`
    );
  }

  return parts.join(";");
}

// Build the full ffmpeg CLI argument list for multi-output transcoding.
// Example output array:
//   [
//     "-nostdin", "-i", "input.mp4",
//     "-filter_complex", "[0:v]split=2[v0][v1];[v0]scale=426:240[v0out];[v1]scale=1280:720[v1out]",
//     "-map", "[v0out]", "-map", "0:a?", ... "-c:v", "libx264", ... "240p.mp4",
//     "-map", "[v1out]", "-map", "0:a?", ... "-c:v", "libx264", ... "720p.mp4"
//   ]
function buildArguments(
  input: string,
  outputs: readonly TranscodeOutput[]
): string[] {
  const args: string[] = [
    "-nostdin",
    "-i",
    input,
    "-filter_complex",
    buildFilterComplex(outputs),
    "-loglevel",
    "verbose",
  ];

  for (let i = 0; i < outputs.length; i++) {
    args.push(
      "-map",
      // Map the scaled video branch for this output.
      // Must use brackets because [v0out] is a named filter output/pad label.
      // Example: -map [v0out]
      `[v${i}out]`,
      // Map the input audio if it exists; "?" means okay if missing.
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputs[i].path
    );
  }

  return args;
}

// Spawn a single ffmpeg process that produces multiple outputs from one decode.
//
// Example invocation:
//   transcode({
//     input: "/tmp/.../original.mp4",
//     outputs: [
//       { name: "240p", width: 426, height: 240, path: "/tmp/.../240p.mp4" },
//       { name: "720p", width: 1280, height: 720, path: "/tmp/.../720p.mp4" }
//     ],
//     timeoutMs: 1800000
//   })
export const transcode = ({
  input,
  outputs,
  timeoutMs,
}: TranscodeOptions): Promise<TranscodeResult> => {
  return new Promise((res, rej) => {
    const args = buildArguments(input, outputs);
    const child = spawn(resolvedFfmpeg!, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Hard timeout guard. If ffmpeg hangs, kill it and fail fast.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(
        new Error(
          `Transcode timeout after ${timeoutMs}ms` +
            (stderr.length > 0 ? `\nFFmpeg stderr: ${stderr}` : "")
        )
      );
    }, timeoutMs);

    // Capture stdout/stderr for diagnostics.
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    // ffmpeg logs progress to stderr, not stdout.
    // Example progress line:
    //   frame= 12 fps= 45 q=23.0 size= 512kB time=00:00:00.50 bitrate=8256.3kbits/s speed=0.8x
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        logger.debug(
          {
            outputs: outputs.map((o) => o.name),
            currentTime: `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`,
          },
          "FFmpeg progress"
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info(
          { outputs: outputs.map((o) => o.name) },
          "FFmpeg multi-output complete"
        );
        res({ outputs: outputs.map((o) => ({ name: o.name, path: o.path })) });
      } else {
        // Include ffmpeg's full stderr/stdout so failures are diagnosable
        // without having to rerun with extra logging.
        const trimmedStderr = stderr.trim();
        const errorMessage =
          `FFmpeg exited with code ${code}` +
          (trimmedStderr.length > 0 ? `\nstderr: ${trimmedStderr}` : "") +
          (stdout.trim().length > 0 ? `\nstdout: ${stdout.trim()}` : "");
        logger.error({ code, input, outputs: outputs.map((o) => o.name), stderr, stdout }, errorMessage);
        rej(new Error(errorMessage));
      }
    });
  });
};
