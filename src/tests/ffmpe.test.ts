import { describe, it, expect, vi, beforeEach } from "vitest";

let lastInstance: any;
const spawnMock = vi.fn(() => {
  const instance = {
    on: vi.fn(function (this: any, event: string, handler: (...args: any[]) => void) {
      instance.on.mock.calls.push([event, handler]);
      return instance;
    }),
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    kill: vi.fn(),
  };
  lastInstance = instance;
  return instance;
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock as any,
  execSync: vi.fn(() => "/usr/bin/ffmpeg"),
}));

describe("phases/ffmpe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockClear();
    lastInstance = null;
  });

  it("should spawn ffmpeg with single output and resolve on exit 0", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      outputs: [{ name: "720p", path: "out.mp4", width: 1280, height: 720 }],
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    onCalls.find(([e]: any) => e === "close")?.[1]?.(0);

    await expect(p).resolves.toEqual({
      outputs: [{ name: "720p", path: "out.mp4" }],
    });
  });

  it("should reject on non-zero exit code", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      outputs: [{ name: "720p", path: "out.mp4", width: 1280, height: 720 }],
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    const closeHandler = onCalls.find(([e]: any) => e === "close")?.[1];
    const errorHandler = onCalls.find(([e]: any) => e === "error")?.[1];

    errorHandler?.(null);
    closeHandler?.(1);

    await expect(p).rejects.toThrow("FFmpeg exited with code 1");
  });

  it("should reject after timeout duration", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      outputs: [{ name: "720p", path: "out.mp4", width: 1280, height: 720 }],
      timeoutMs: 50,
    });

    await expect(p).rejects.toThrow("Transcode timeout after 50ms");
    expect(lastInstance.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("should build multi-output arguments", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      outputs: [
        { name: "240p", path: "240.mp4", width: 426, height: 240 },
        { name: "720p", path: "720.mp4", width: 1280, height: 720 },
      ],
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    onCalls.find(([e]: any) => e === "close")?.[1]?.(0);

    await expect(p).resolves.toEqual({
      outputs: [
        { name: "240p", path: "240.mp4" },
        { name: "720p", path: "720.mp4" },
      ],
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as any;
    expect(call).toBeDefined();
    const args = call[1] as string[];
    expect(args).toContain("-filter_complex");
    expect(args).toContain("-map");
    expect(args).toContain("[v0out]");
    expect(args).toContain("[v1out]");
  });
});
