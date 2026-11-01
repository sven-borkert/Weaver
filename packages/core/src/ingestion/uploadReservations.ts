import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import { withProjectIngestionLifecycleLock } from "../services/ingestion";
import { retainedBytes } from "./blobReferences";

const LEASE_MS = 5 * 60_000;
const RESERVATION_STEP = 1024 * 1024;
const quotaExceeded = () =>
  new CoreError("PRECONDITION_FAILED", "project upload quota exceeded");

/** Holds quota for staged bytes until publication or cleanup finishes. */
export async function reserveUpload(
  db: PrismaClient,
  input: {
    userId: string;
    projectId: string;
    declaredBytes: number;
    quotaBytes: number;
  },
) {
  const id = randomUUID();
  const projectId = input.projectId.toLowerCase();
  if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0)
    throw new CoreError("BAD_REQUEST", "invalid upload size");
  let reserved = input.declaredBytes;
  let consumed = 0;
  let lost = false;
  let released = false;
  let expiresAt = Date.now() + LEASE_MS;
  await withProjectIngestionLifecycleLock(db, projectId, async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-user:${input.userId}`}, 0))`,
    );
    const now = new Date();
    await tx.uploadReservation.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    if (
      (await tx.uploadReservation.count({ where: { userId: input.userId } })) >=
      3
    )
      throw new CoreError("TOO_MANY_REQUESTS", "too many concurrent uploads");
    const total = await tx.uploadReservation.aggregate({
      where: { projectId },
      _sum: { bytes: true },
    });
    if (
      (await retainedBytes(tx, projectId, [])) +
        (total._sum.bytes ?? 0n) +
        BigInt(reserved) >
      BigInt(input.quotaBytes)
    )
      throw quotaExceeded();
    await tx.uploadReservation.create({
      data: {
        id,
        projectId,
        userId: input.userId,
        bytes: BigInt(reserved),
        expiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
  });
  const heartbeat = setInterval(() => {
    const nextExpiry = Date.now() + LEASE_MS;
    void db.uploadReservation
      .updateMany({
        where: { id, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date(nextExpiry) },
      })
      .then(
        (result) => {
          if (result.count !== 1) lost = true;
          else expiresAt = nextExpiry;
        },
        () => {
          lost = true;
        },
      );
  }, 30_000);
  heartbeat.unref();
  return {
    async consume(bytes: number) {
      if (released || lost || Date.now() >= expiresAt)
        throw new CoreError(
          "PRECONDITION_FAILED",
          "upload reservation expired; retry upload",
        );
      consumed += bytes;
      if (consumed <= reserved) return;
      await withProjectIngestionLifecycleLock(db, projectId, async (tx) => {
        const now = new Date();
        const current = await tx.uploadReservation.findFirst({
          where: { id, expiresAt: { gt: now } },
        });
        if (!current)
          throw new CoreError(
            "PRECONDITION_FAILED",
            "upload reservation expired; retry upload",
          );
        const others = await tx.uploadReservation.aggregate({
          where: { projectId, id: { not: id }, expiresAt: { gt: now } },
          _sum: { bytes: true },
        });
        const available =
          BigInt(input.quotaBytes) -
          (await retainedBytes(tx, projectId, [])) -
          (others._sum.bytes ?? 0n);
        if (BigInt(consumed) > available) throw quotaExceeded();
        reserved = Math.min(
          Number(available),
          Math.ceil(consumed / RESERVATION_STEP) * RESERVATION_STEP,
        );
        await tx.uploadReservation.update({
          where: { id },
          data: {
            bytes: BigInt(reserved),
            expiresAt: new Date(Date.now() + LEASE_MS),
          },
        });
      });
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await db.uploadReservation.deleteMany({ where: { id } });
    },
  };
}
