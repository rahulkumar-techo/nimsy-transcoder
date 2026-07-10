import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("../../src/config.js", () => ({
  config: {
    aws: { S3_TEMP_BUCKET: "temp-bucket", S3_PROD_BUCKET: "prod-bucket" },
    FFMPEG_TIMEOUT_MS: 1000,
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockS3Send = vi.fn();
vi.mock("../../src/s3.js", () => ({
  s3: {
    send: mockS3Send,
  },
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class MockUpload {
    done = vi.fn().mockResolvedValue(undefined);
  }
}));

describe("phases/download-file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should run pipeline and resolve on success", async () => {
    const inputStream = Readable.from(["fake video content"]);
    mockS3Send.mockResolvedValue({ Body: inputStream });

    const transcode = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/phases/ffmpe.js", () => ({
      transcode,
    }));

    const { processVideoPipeline } = await import("../phases/download-file.js");

    await processVideoPipeline({
      inputKey: "uploads/v.mp4",
      outputKey: "videos/1/720p.mp4",
      outputConfig: { name: "720p", width: 1280, height: 720 },
    });

    expect(transcode).toHaveBeenCalledTimes(1);
    expect(transcode).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ name: "720p" }),
      })
    );
  });

  it("should reject when s3 returns empty body", async () => {
    mockS3Send.mockResolvedValue({ Body: null });

    const { processVideoPipeline } = await import("../phases/download-file.js");

    await expect(
      processVideoPipeline({
        inputKey: "uploads/v.mp4",
        outputKey: "videos/1/720p.mp4",
        outputConfig: { name: "720p", width: 1280, height: 720 },
      })
    ).rejects.toThrow("Empty S3 object body for key: uploads/v.mp4");
  });
});
