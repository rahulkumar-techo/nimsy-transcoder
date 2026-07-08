import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/config.js", () => ({
  config: {
    aws: { S3_TEMP_BUCKET: "temp-bucket" },
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

describe("phases/download-file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should return metrics after successful download", async () => {
    const content = "fake video content";
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcode-test-"));
    const sourcePath = path.join(tmpDir, "source.mp4");
    await fsp.writeFile(sourcePath, content);

    const readable = fs.createReadStream(sourcePath);
    mockS3Send.mockResolvedValueOnce({ Body: readable });

    const { downloadFile } = await import("../phases/download-file.js");

    const outPath = path.join(tmpDir, "out.mp4");
    const result = await downloadFile({
      objectKey: "uploads/v.mp4",
      inputFile: outPath,
      baseContext: { videoId: "1", objectKey: "uploads/v.mp4", correlationId: "c1", deliveryTag: "dt1" },
    });

    expect(result).toEqual(
      expect.objectContaining({
        inputFile: expect.stringContaining("out.mp4"),
        durationMs: expect.any(Number),
        sizeBytes: content.length,
      })
    );
  });

  it("should reject and clean up when download times out", async () => {
    process.env.DOWNLOAD_TIMEOUT_MS = "5000";

    vi.useFakeTimers();

    vi.doMock("node:stream/promises", async () => {
      const actual = await vi.importActual("node:stream/promises");
      return {
        ...actual,
        pipeline: vi.fn(() => new Promise(() => {})),
      };
    });

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcode-test-"));
    const sourcePath = path.join(tmpDir, "exists.mp4");
    await fsp.writeFile(sourcePath, "exists");

    mockS3Send.mockResolvedValueOnce({
      Body: fs.createReadStream(sourcePath),
    });

    const { downloadFile } = await import("../phases/download-file.js");

    const outPath = path.join(tmpDir, "timeout-out.mp4");

    const p = downloadFile({
      objectKey: "uploads/v.mp4",
      inputFile: outPath,
      baseContext: { videoId: "2", objectKey: "uploads/v.mp4", correlationId: "c2", deliveryTag: "dt2" },
    });

    await vi.advanceTimersByTimeAsync(10000);

    await expect(p).rejects.toThrow(/Download timeout/);

    vi.useRealTimers();
  });

  it("should reject when s3 returns empty body", async () => {
    mockS3Send.mockResolvedValueOnce({ Body: null });

    const { downloadFile } = await import("../phases/download-file.js");

    await expect(
      downloadFile({
        objectKey: "uploads/v.mp4",
        inputFile: path.join(os.tmpdir(), "empty.mp4"),
        baseContext: { videoId: "3", objectKey: "uploads/v.mp4", correlationId: "c3", deliveryTag: "dt3" },
      })
    ).rejects.toThrow("Download failed: empty response body");
  });
});
