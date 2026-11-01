import { db } from "@weaver/db";
import { reserveUpload } from "@weaver/core/ingestion/uploadReservations";
import { env } from "~/env";

export function createUploadBudget(req: Request, userId: string) {
  let reservation: Awaited<ReturnType<typeof reserveUpload>> | undefined;
  return {
    async reserve(projectId: string) {
      const header = req.headers.get("content-length");
      reservation = await reserveUpload(db, {
        userId,
        projectId,
        declaredBytes: header && /^\d+$/.test(header) ? Number(header) : 0,
        quotaBytes: env.WEAVER_INGESTION_PROJECT_QUOTA_BYTES,
      });
    },
    async beforeWrite(this: void, bytes: number) {
      if (!reservation)
        throw new Error("upload must be authorized before staging");
      await reservation.consume(bytes);
    },
    async release() {
      await reservation?.release();
    },
  };
}
