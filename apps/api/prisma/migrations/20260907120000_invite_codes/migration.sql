-- Closed-alpha invite codes (ADR-0033).

ALTER TABLE "User" ADD COLUMN "invitedViaCode" TEXT;

CREATE TABLE "InviteCode" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "code"        TEXT NOT NULL,
  "createdById" UUID,
  "maxUses"     INTEGER NOT NULL DEFAULT 1,
  "usedCount"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"   TIMESTAMP(3),
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");
CREATE INDEX "InviteCode_code_idx" ON "InviteCode"("code");

ALTER TABLE "InviteCode"
  ADD CONSTRAINT "InviteCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
