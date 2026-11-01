import type { Prisma, PrismaClient } from "@weaver/db/client";

type Db = PrismaClient | Prisma.TransactionClient;

export async function getSystemSetting(db: Db, key: string): Promise<unknown> {
  const row = await db.systemSetting.findUnique({
    where: { key },
    select: { value: true },
  });
  return row ? row.value : null;
}

export async function setSystemSetting(
  db: Db,
  input: {
    key: string;
    value: Prisma.InputJsonValue;
    updatedById: string | null;
  },
): Promise<void> {
  await db.systemSetting.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      value: input.value,
      updatedById: input.updatedById,
    },
    update: { value: input.value, updatedById: input.updatedById },
  });
}
