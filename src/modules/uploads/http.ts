import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { ImageUploadService, StagedUpload } from "./service.js";
import { assertCsrf, requireAuthenticated } from "../auth/http.js";
import { requireDashboardSurface } from "../../security/request-trust.js";
import { AppError, ValidationError } from "../../core/errors.js";

export async function registerImageUploadRoutes(
  app: FastifyInstance,
  service: ImageUploadService,
  maxUploadBytes = 2 * 1024 * 1024,
): Promise<void> {
  await app.register(multipart, {
    limits: { fields: 8, fileSize: maxUploadBytes, files: 1, parts: 10 },
  });

  app.post(
    "/upload.php",
    { preHandler: requireDashboardSurface },
    async (request, reply) => {
      let staged: StagedUpload | null = null;
      let csrf: string | undefined;
      try {
        const auth = requireAuthenticated(request);
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (csrf === undefined) {
              part.file.resume();
              assertCsrf(auth.session, undefined);
            }
            if (part.fieldname !== "image" || staged !== null) {
              part.file.resume();
              throw new ValidationError("Upload one image.", "INVALID_IMAGE_FIELD");
            }
            staged = await service.stage(part.file);
            if (part.file.truncated) {
              throw new ValidationError("Image file is too large.", "IMAGE_TOO_LARGE");
            }
          } else if (part.fieldname === "csrf") {
            if (csrf !== undefined) {
              throw new ValidationError("Duplicate csrf field.", "DUPLICATE_FORM_FIELD");
            }
            const supplied = String(part.value);
            assertCsrf(auth.session, supplied);
            csrf = supplied;
          }
        }
        assertCsrf(auth.session, csrf);
        if (staged === null) {
          throw new ValidationError("No image received", "EMPTY_IMAGE");
        }
        const result = await service.complete(staged, auth.user.id, auth.session);
        staged = null;
        return { ok: true, path: result.path, image_info: result.imageInfo };
      } catch (error) {
        if (error instanceof AppError) {
          await reply.code(error.statusCode).send({ ok: false, error: error.expose ? error.message : "Upload failed" });
          return;
        }
        request.log.error({ err: error }, "image upload failed");
        const statusCode = multipartStatusCode(error);
        await reply.code(statusCode).send({
          ok: false,
          error: statusCode === 413 ? "Image file is too large." : "Upload failed",
        });
        return;
      } finally {
        await service.discard(staged);
      }
    },
  );

  app.route({
    method: ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/upload.php",
    preHandler: requireDashboardSurface,
    handler: async (_request, reply) => reply.code(405).send({ ok: false, error: "POST required" }),
  });
}

function multipartStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error
    && (error as { statusCode?: unknown }).statusCode === 413) {
    return 413;
  }
  return 400;
}
