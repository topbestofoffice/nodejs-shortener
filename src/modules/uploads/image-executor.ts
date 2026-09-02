import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { AppError, ValidationError } from "../../core/errors.js";

export interface ImageExecutionRequest {
  readonly jobId: string;
  readonly attempt: number;
  readonly inputPath: string;
  readonly outputTempPath: string;
  readonly finalPath: string;
  readonly maxPixels: number;
  readonly deferPublication: boolean;
}

export interface ImageExecutionResult {
  readonly width: 1200;
  readonly height: 630;
  readonly format: "jpeg";
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export interface ImageExecutor {
  execute(request: ImageExecutionRequest): Promise<ImageExecutionResult>;
}

export class SharpConcurrencyOneExecutor implements ImageExecutor {
  #busy = false;

  public async execute(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
    if (this.#busy) {
      throw new AppError("Image processor is temporarily unavailable", 429, "IMAGE_PROCESSOR_BUSY");
    }
    this.#busy = true;
    try {
      return await processImage(request);
    } finally {
      this.#busy = false;
    }
  }
}

export async function processImage(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
  const inputOptions = { animated: false, failOn: "warning" as const, limitInputPixels: request.maxPixels, pages: 1 };
  const source = sharp(request.inputPath, inputOptions);
  const metadata = await source.metadata();
  const allowed = new Set(["jpeg", "png", "gif", "webp"]);
  if (metadata.format === undefined || !allowed.has(metadata.format)
    || metadata.width === undefined || metadata.height === undefined
    || metadata.width < 1 || metadata.height < 1
    || metadata.width * metadata.height > request.maxPixels) {
    throw new ValidationError("Upload a valid JPEG, PNG, GIF or WebP image.", "INVALID_IMAGE");
  }

  const stats = await sharp(request.inputPath, inputOptions).stats();
  const background = {
    r: stats.dominant.r,
    g: stats.dominant.g,
    b: stats.dominant.b,
    alpha: 1,
  };
  await mkdir(dirname(request.outputTempPath), { recursive: true });
  await mkdir(dirname(request.finalPath), { recursive: true });
  await sharp(request.inputPath, inputOptions)
    .rotate()
    .flatten({ background })
    .resize(1200, 630, { fit: "contain", background })
    .jpeg({ quality: 87, progressive: true, chromaSubsampling: "4:2:0" })
    .toFile(request.outputTempPath);
  if (request.deferPublication) {
    await chmod(request.outputTempPath, 0o600);
  } else {
    await chmod(request.outputTempPath, 0o644);
    await rename(request.outputTempPath, request.finalPath);
  }

  return {
    width: 1200,
    height: 630,
    format: "jpeg",
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
  };
}

export async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
