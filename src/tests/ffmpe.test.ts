import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fluent-ffmpeg", () => {
  const fn = vi.fn();
  (fn as any).setFfmpegPath = vi.fn();
  return { default: fn };
});

vi.mock("ffmpeg-static", () => ({
  default: "/usr/bin/ffmpeg",
}));

describe("phases/ffmpe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve when end event is emitted", async () => {
    const fluentFfmpegMock = (await import("fluent-ffmpeg")) as any;
    (fluentFfmpegMock.default as any).setFfmpegPath = vi.fn();

    fluentFfmpegMock.default.mockImplementation(() => {
      const handlers: Record<string, (...args: any[]) => void> = {};
      const command = {
        videoCodec: vi.fn().mockReturnThis(),
        audioCodec: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return command;
        }),
        on: vi.fn().mockReturnThis(),
        run: vi.fn(),
        kill: vi.fn(),
      };
      return command;
    });

    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      output: "out.mp4",
      width: 320,
      height: 180,
      timeoutMs: 5000,
    });

    const instance = fluentFfmpegMock.default.mock.results[0]?.value;
    const endCalls = (instance?.once?.mock?.calls) as any[] | undefined;
    const endHandler = endCalls?.find(([e]: [string]) => e === "end")?.[1] as (() => void) | undefined;

    expect(endHandler).toBeDefined();
    endHandler!();

    await expect(p).resolves.toBeUndefined();
  });

  it("should reject after timeout duration", async () => {
    const fluentFfmpegMock = (await import("fluent-ffmpeg")) as any;
    (fluentFfmpegMock.default as any).setFfmpegPath = vi.fn();

    fluentFfmpegMock.default.mockImplementation(() => {
      const command = {
        videoCodec: vi.fn().mockReturnThis(),
        audioCodec: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        once: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        run: vi.fn(),
        kill: vi.fn(),
      };
      return command;
    });

    const { transcode } = await import("../phases/ffmpe.js");

    const timeoutMs = 50;
    const p = transcode({
      input: "in.mp4",
      output: "out.mp4",
      width: 320,
      height: 180,
      timeoutMs,
    });

    const instance = fluentFfmpegMock.default.mock.results[0]?.value;
    instance.kill.mockClear();

    await expect(p).rejects.toThrow(`Transcode timeout after ${timeoutMs}ms`);
    expect(instance.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("should reject on error event", async () => {
    const fluentFfmpegMock = (await import("fluent-ffmpeg")) as any;
    (fluentFfmpegMock.default as any).setFfmpegPath = vi.fn();

    fluentFfmpegMock.default.mockImplementation(() => {
      const handlers: Record<string, (...args: any[]) => void> = {};

      const command = {
        videoCodec: vi.fn().mockReturnThis(),
        audioCodec: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        output: vi.fn().mockReturnThis(),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return command;
        }),
        on: vi.fn().mockReturnThis(),
        run: vi.fn(),
        kill: vi.fn(),
      };

      return command;
    });

    const { transcode } = await import("../phases/ffmpe.js");

    const p = transcode({
      input: "in.mp4",
      output: "out.mp4",
      width: 320,
      height: 180,
      timeoutMs: 5000,
    });

    const instance = fluentFfmpegMock.default.mock.results[0]?.value;
    const errorCalls = (instance?.once?.mock?.calls) as any[] | undefined;
    const errorHandler = errorCalls?.find(([e]: [string]) => e === "error")?.[1] as ((err: Error) => void) | undefined;

    expect(errorHandler).toBeDefined();
    errorHandler!(new Error("ffmpeg boom"));

    await expect(p).rejects.toThrow("ffmpeg boom");
  });
});
