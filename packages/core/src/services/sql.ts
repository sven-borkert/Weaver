import { Prisma } from "@weaver/db/client";

/** Prisma stores `timestamp(3)` columns as UTC wall-clock; raw SQL must never use the session-zoned CURRENT_TIMESTAMP. */
export const UTC_NOW = Prisma.sql`timezone('UTC', now())`;
