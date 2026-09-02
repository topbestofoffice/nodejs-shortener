import sharp from "sharp";
import type { ImageMetadata, ImageMetadataReader } from "../modules/redirect/preview.js";
import { managedImageFilename } from "../modules/uploads/managed-image-path.js";

export class SharpMetadataReader implements ImageMetadataReader {
  public constructor(
    private readonly publicUploadDir: string,
    private readonly maxInputPixels: number,
  ) {
    if (!Number.isSafeInteger(maxInputPixels) || maxInputPixels < 1) {
      throw new RangeError("maxInputPixels must be a positive safe integer.");
    }
  }

  public async read(relativePath: string): Promise<ImageMetadata | null> {
    const filename = managedImageFilename(relativePath);
    if (filename === null) {
      return null;
    }
    try {
      const metadata = await sharp(`${this.publicUploadDir}/${filename}`, {
        failOn: "warning",
        limitInputPixels: this.maxInputPixels,
      }).metadata();
      if (metadata.width === undefined || metadata.height === undefined) {
        return null;
      }
      const mime = metadata.format === "jpeg"
        ? "image/jpeg"
        : metadata.format === "png"
          ? "image/png"
          : metadata.format === "gif"
            ? "image/gif"
            : metadata.format === "webp"
              ? "image/webp"
              : null;
      return { width: metadata.width, height: metadata.height, mime };
    } catch {
      return null;
    }
  }
}
