import { hasVaapi, hasNvenc, getCpuThreads, isWeakCpu } from "./video-info.js";

const ALL_RESOLUTIONS = [
  { name: "240p", width: 426, height: 240 },
  { name: "360p", width: 640, height: 360 },
  { name: "480p", width: 854, height: 480 },
  { name: "720p", width: 1280, height: 720 },
] as const;

export interface SystemProfile {
  hasGpu: boolean;
  cpuThreads: number;
  isPowerful: boolean;
  isWeak: boolean;
}

export function detectProfile(): SystemProfile {
  const gpu = hasVaapi() || hasNvenc();
  const threads = getCpuThreads();
  const weak = isWeakCpu();
   if (!require("fs").existsSync("/dev/dri")) {
    return { hasGpu: false, cpuThreads: 4, isPowerful: false, isWeak: true };
  }
  
  return {
    hasGpu: gpu,
    cpuThreads: threads,
    isPowerful: gpu || (!weak && threads >= 4), // 4+ threads AND not an i3
    isWeak: weak,
  };
}

export function getResolutions(durationSec: number, profile: SystemProfile = detectProfile()) {
  // GPU or powerful CPU: all resolutions
  if (profile.isPowerful) {
    return [...ALL_RESOLUTIONS];
  }

  // Weak CPU (i3, etc.): only 360p + 480p, always
  return ALL_RESOLUTIONS.filter((r) => r.name === "360p" || r.name === "480p");
}

export function getConcurrency(profile: SystemProfile = detectProfile()): number {
  if (profile.isWeak) return 1;       // i3: never parallel
  if (profile.hasGpu) return 2;       // GPU: can do 2
  if (profile.cpuThreads >= 6) return 2; // 6+ real cores: can do 2
  return 1;                           // everything else: safe
}

export { ALL_RESOLUTIONS };