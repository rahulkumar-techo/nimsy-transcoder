import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

export async function getVideoDuration(inputPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

export function hasVaapi(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-init_hw_device", "vaapi", "-hwaccels"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function hasNvenc(): boolean {
  try {
    const stdout = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 5000,
    }) as string;
    return stdout.includes("h264_nvenc");
  } catch {
    return false;
  }
}

export function getCpuThreads(): number {
  return os.cpus().length;
}

/** Detect if this is a weak CPU (i3, Celeron, Atom, old Pentium). */
export function isWeakCpu(): boolean {
  const model = os.cpus()[0]?.model.toLowerCase() || "";
  return (
    model.includes("i3") ||
    model.includes("celeron") ||
    model.includes("atom") ||
    model.includes("pentium") ||
    model.includes("m3") ||
    model.includes("j4125") || // common low-power embedded
    model.includes("n5105") ||
    getCpuThreads() <= 2       // anything with 2 or fewer threads is weak
  );
}