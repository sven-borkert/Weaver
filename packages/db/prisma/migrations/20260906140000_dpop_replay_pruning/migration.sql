-- Keep per-request DPoP replay pruning bounded to expired replay tombstones.
CREATE INDEX "Verification_dpop_replay_expiry_idx"
ON "Verification" ("expiresAt")
WHERE "identifier" LIKE 'dpop-proof:%';
