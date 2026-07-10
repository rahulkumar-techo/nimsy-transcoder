import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";

let lastInstance: any;
const spawnMock = vi.fn(() => {
  const stdin = new Writable({
    write(chunk: any, encoding: string, callback: (err?: Error) => void) {
      callback(err);
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const instance = {
    stdin,
    stdout,
    stderr,
    on: vi.fn(function (this: any, event: string, handler: (...args: any[]) => void) {
      instance.on.mock.calls.push([event, handler]);
      return instance;
    }),
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

  it("should spawn ffmpeg for one output and resolve on exit 0", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(chunk: any, encoding: string, callback: (err?: Error) => void) {
        callback(err);
      },
    });

    const p = transcode({
      inputStream,
      outputStream,
      output: { name: "720p", width: 1280, height: 720 },
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    onCalls.find(([e]: any) => e === "close")?.[1]?.(0);

    await expect(p).resolves.toBeUndefined();
  });

  it("should reject on non-zero exit code", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(chunk: any, encoding: string, callback: (err?: Error) => void) {
        callback(err);
      },
    });

    const p = transcode({
      inputStream,
      outputStream,
      output: { name: "720p", width: 1280, height: 720 },
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    onCalls.find(([e]: any) => e === "close")?.[1]?.(1);

    await expect(p).rejects.toThrow("FFmpeg exited with code 1 for 720p");
  });

  it("should reject after timeout duration", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(chunk: any, encoding: string, callback: (err?: Error) => void) {
        callback(err);
      },
    });

    const p = transcode({
      inputStream,
      outputStream,
      output: { name: "720p", width: 1280, height: 720 },
      timeoutMs: 50,
    });

    await expect(p).rejects.toThrow("Transcode timeout after 50ms for 720p");
    expect(lastInstance.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("should build correct streaming arguments", async () => {
    const { transcode } = await import("../phases/ffmpe.js");

    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(chunk: any, encoding: string, callback: (err?: Error) => void) {
        callback(err);
      },
    });

    const p = transcode({
      inputStream,
      outputStream,
      output: { name: "720p", width: 1280, height: 720 },
      timeoutMs: 5000,
    });

    const onCalls = lastInstance.on.mock.calls as any[];
    onCalls.find(([e]: any) => e === "close")?.[1]?.(0);

    await expect(p).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as any;
    expect(call).toBeDefined();
    const args = call[1] as string[];
    expect(args).toContain("-vf");
    expect(args).toContain("scale=1280:720");
    expect(args).toContain("-f");
    expect(args).toContain("mp4");
  });
});
