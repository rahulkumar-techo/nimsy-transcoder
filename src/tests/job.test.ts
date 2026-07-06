import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

const mockConfig = {
  aws: { S3_TEMP_BUCKET: "temp-bucket", S3_PROD_BUCKET: "prod-bucket" },
  TEMP_DIR: os.tmpdir(),
  FFMPEG_TIMEOUT_MS: 1000,
};

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

describe("job.ts", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should complete full transcode job successfully", async () => {
    vi.doMock("./config.js", () => ({
      config: mockConfig,
      logger,
    }));

    const s3Send = vi.fn().mockResolvedValue({});
    vi.doMock("./s3.js", () => ({
      s3: { send: s3Send },
    }));

    const downloadFile = vi.fn().mockResolvedValue({
      inputFile: path.join(mockConfig.TEMP_DIR, "in.mp4"),
      durationMs: 1200,
      sizeBytes: 1024,
    });
    vi.doMock("./phases/download-file.js", () => ({
      downloadFile,
    }));

    const transcode = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./phases/ffmpe.js", () => ({
      transcode,
    }));

    const thumbnailGenAndUpload = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./phases/thumbnail.js", () => ({
      thumbnailGenAndUpload,
    }));

    const notify = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./helper/notify.js", () => ({
      notify,
    }));

    const uploadWithRetry = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./helper/uploadWithRetry.js", () => ({
      uploadWithRetry,
    }));

    const retry = vi.fn(async (fn: any) => fn());
    vi.doMock("./helper/retry.js", () => ({
      retry,
    }));

    const cleanupPartialUploads = vi.fn();
    vi.doMock("./helper/cleanupPartialUploads.js", () => ({
      cleanupPartialUploads,
    }));

    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined as any);
    vi.spyOn(fsp, "stat").mockResolvedValue({ size: 2048 } as any);
    const rmSpy = vi.spyOn(fsp, "rm").mockResolvedValue(undefined as any);

    const jobModule = await import("./job.js");
    const processJob = jobModule.default;

    const payload = {
      videoId: "vid-1",
      objectKey: "uploads/original.mp4",
      correlationId: "corr-1",
      deliveryTag: "dt-1",
      thumbnailKey: undefined,
    };

    await processJob(payload);

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(transcode).toHaveBeenCalledTimes(4);
    expect(thumbnailGenAndUpload).toHaveBeenCalledWith({ thumbnailKey: null });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: "vid-1",
        status: "PUBLISHED",
        qualities: ["240p", "360p", "480p", "720p"],
        objectKey: "uploads/original.mp4",
      }),
      "corr-1",
      "dt-1",
      false
    );
    expect(cleanupPartialUploads).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
      "Job completed"
    );
    expect(rmSpy).toHaveBeenCalled();
  });

  it("should cleanup and notify failure when download fails", async () => {
    vi.doMock("./config.js", () => ({
      config: mockConfig,
      logger,
    }));

    const s3Send = vi.fn().mockResolvedValue({});
    vi.doMock("./s3.js", () => ({
      s3: { send: s3Send },
    }));

    const downloadFile = vi.fn().mockRejectedValue(new Error("Download failed"));
    vi.doMock("./phases/download-file.js", () => ({
      downloadFile,
    }));

    const cleanupPartialUploads = vi.fn();
    vi.doMock("./helper/cleanupPartialUploads.js", () => ({
      cleanupPartialUploads,
    }));

    const notify = vi.fn();
    vi.doMock("./helper/notify.js", () => ({
      notify,
    }));

    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined as any);
    const rmSpy = vi.spyOn(fsp, "rm").mockResolvedValue(undefined as any);

    const jobModule = await import("./job.js");
    const processJob = jobModule.default;

    const payload = {
      videoId: "vid-fail",
      objectKey: "uploads/original.mp4",
      correlationId: "corr-fail",
      deliveryTag: "dt-fail",
      thumbnailKey: undefined,
    };

    await expect(processJob(payload)).rejects.toThrow("Download failed");

    expect(cleanupPartialUploads).toHaveBeenCalledWith([], "vid-fail");
    expect(notify).toHaveBeenCalledWith(
      { videoId: "vid-fail", error: "Download failed" },
      "corr-fail",
      "dt-fail",
      true
    );
    expect(rmSpy).toHaveBeenCalled();
  });

  it("should preserve temp source when job fails", async () => {
    vi.doMock("./config.js", () => ({
      config: mockConfig,
      logger,
    }));

    const s3Send = vi.fn().mockResolvedValue({});
    vi.doMock("./s3.js", () => ({
      s3: { send: s3Send },
    }));

    const downloadFile = vi.fn().mockResolvedValue({
      inputFile: path.join(mockConfig.TEMP_DIR, "in.mp4"),
      durationMs: 1200,
      sizeBytes: 1024,
    });
    vi.doMock("./phases/download-file.js", () => ({
      downloadFile,
    }));

    const transcode = vi.fn().mockRejectedValue(new Error("Transcode boom"));
    vi.doMock("./phases/ffmpe.js", () => ({
      transcode,
    }));

    const cleanupPartialUploads = vi.fn();
    vi.doMock("./helper/cleanupPartialUploads.js", () => ({
      cleanupPartialUploads,
    }));

    const notify = vi.fn();
    vi.doMock("./helper/notify.js", () => ({
      notify,
    }));

    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined as any);
    vi.spyOn(fsp, "stat").mockResolvedValue({ size: 0 } as any);
    const rmSpy = vi.spyOn(fsp, "rm").mockResolvedValue(undefined as any);

    const jobModule = await import("./job.js");
    const processJob = jobModule.default;

    const payload = {
      videoId: "vid-ok",
      objectKey: "uploads/original.mp4",
      correlationId: "corr-ok",
      deliveryTag: "dt-ok",
      thumbnailKey: undefined,
    };

    await expect(processJob(payload)).rejects.toThrow("Transcode boom");

    expect(logger.warn).toHaveBeenCalledWith(
      { videoId: "vid-ok", objectKey: "uploads/original.mp4" },
      "Preserving temp source for retry/troubleshooting"
    );
    expect(s3Send).not.toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalled();
  });

  it("should delete temp source when job succeeds", async () => {
    vi.doMock("./config.js", () => ({
      config: mockConfig,
      logger,
    }));

    const s3Send = vi.fn().mockResolvedValue({});
    vi.doMock("./s3.js", () => ({
      s3: { send: s3Send },
    }));

    const downloadFile = vi.fn().mockResolvedValue({
      inputFile: path.join(mockConfig.TEMP_DIR, "in.mp4"),
      durationMs: 1200,
      sizeBytes: 1024,
    });
    vi.doMock("./phases/download-file.js", () => ({
      downloadFile,
    }));

    const transcode = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./phases/ffmpe.js", () => ({
      transcode,
    }));

    const thumbnailGenAndUpload = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./phases/thumbnail.js", () => ({
      thumbnailGenAndUpload,
    }));

    const notify = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./helper/notify.js", () => ({
      notify,
    }));

    const uploadWithRetry = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./helper/uploadWithRetry.js", () => ({
      uploadWithRetry,
    }));

    const retry = vi.fn(async (fn: any) => fn());
    vi.doMock("./helper/retry.js", () => ({
      retry,
    }));

    vi.spyOn(fsp, "mkdir").mockResolvedValue(undefined as any);
    vi.spyOn(fsp, "stat").mockResolvedValue({ size: 2048 } as any);
    const rmSpy = vi.spyOn(fsp, "rm").mockResolvedValue(undefined as any);

    const jobModule = await import("./job.js");
    const processJob = jobModule.default;

    const payload = {
      videoId: "vid-ok",
      objectKey: "uploads/original.mp4",
      correlationId: "corr-ok",
      deliveryTag: "dt-ok",
      thumbnailKey: undefined,
    };

    await processJob(payload);

    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { videoId: "vid-ok", objectKey: "uploads/original.mp4" },
      "Temp source deleted"
    );
    expect(rmSpy).toHaveBeenCalled();
  });
});
