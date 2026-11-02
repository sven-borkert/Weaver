import type { Appearance } from "../../appearance/metadata";
import type { WikiPagePropertiesInput } from "../../wiki/properties";
import type { PrismaClient } from "@weaver/db/client";
import type { EncryptionKeyRing } from "../../security/encryption";

export type RemoteRuntimeDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing;
  fetchImpl: typeof fetch;
  now: () => Date;
  selfBaseUrl: string;
  mcpResourceUrl: string;
  allowedOrigins?: string[];
  /** false lets tests inject an unpinned fake fetch. */
  pinOutbound?: boolean;
};

export type RemoteInstanceView = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  lastCheckedAt: Date | null;
  checkStatus: string | null;
  checkErrorSummary: string | null;
};

/** Portable page properties; reviewExempt and sources never travel. */
export type TransferProperties = {
  properties?: WikiPagePropertiesInput;
};

export type TransferAppearance = {
  appearance?: Appearance;
  iconAssets?: Array<{
    digest: string;
    extension: "png" | "jpg" | "webp";
    bytes: string;
  }>;
};
