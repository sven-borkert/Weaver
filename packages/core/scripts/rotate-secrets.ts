import { rotateOidcSecrets } from "../src/services/oidc/credentials";
import { db } from "@weaver/db";
import { loadEncryptionKeyRing } from "../src/security/encryption";
import { rotateConnectionSecrets } from "../src/services/llmConnections";
import { rotateProjectGitRemoteSecrets } from "../src/services/projectGitRemote";
import { rotateExternalMcpSecrets } from "../src/services/externalMcp";
import { rotateRemoteConnectionSecrets } from "../src/services/remoteInstances";

const ring = loadEncryptionKeyRing();
if (!ring) throw new Error("WEAVER_ENCRYPTION_KEYS is not set");
try {
  const llm = await rotateConnectionSecrets(db, ring);
  const external = await rotateExternalMcpSecrets(db, ring);
  const git = await rotateProjectGitRemoteSecrets(db, ring);
  const remotes = await rotateRemoteConnectionSecrets(db, ring);
  const oidc = await rotateOidcSecrets(db, ring);
  const result = {
    rotated:
      llm.rotated +
      external.rotated +
      git.rotated +
      remotes.rotated +
      oidc.rotated,
    skipped:
      llm.skipped +
      external.skipped +
      git.skipped +
      remotes.skipped +
      oidc.skipped,
  };
  console.log(
    `Rotated ${result.rotated} credential(s) to key version ${ring.activeVersion}; ${result.skipped} already current or concurrently changed.`,
  );
} finally {
  await db.$disconnect();
}
