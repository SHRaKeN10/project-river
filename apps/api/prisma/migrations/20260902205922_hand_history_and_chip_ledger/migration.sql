-- CreateEnum
CREATE TYPE "ChipMovementReason" AS ENUM ('SIGNUP_GRANT', 'REBUY_GRANT', 'TABLE_BUYIN', 'TABLE_BUYIN_REFUND', 'TABLE_CASHOUT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "ChipLedgerEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" "ChipMovementReason" NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "tableId" UUID,
    "idemKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChipLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PokerHand" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tableId" UUID NOT NULL,
    "handNumber" INTEGER NOT NULL,
    "engineHandId" TEXT NOT NULL,
    "deck" JSONB NOT NULL,
    "buttonSeat" INTEGER NOT NULL,
    "smallBlindSeat" INTEGER,
    "bigBlindSeat" INTEGER NOT NULL,
    "seatsJson" JSONB NOT NULL,
    "actionsJson" JSONB NOT NULL,
    "board" TEXT[],
    "resultsJson" JSONB NOT NULL,
    "potTotal" INTEGER NOT NULL,
    "userIds" UUID[],
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PokerHand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChipLedgerEntry_idemKey_key" ON "ChipLedgerEntry"("idemKey");

-- CreateIndex
CREATE INDEX "ChipLedgerEntry_userId_createdAt_idx" ON "ChipLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PokerHand_tableId_endedAt_idx" ON "PokerHand"("tableId", "endedAt");

-- CreateIndex
CREATE INDEX "PokerHand_userIds_idx" ON "PokerHand" USING GIN ("userIds");

-- CreateIndex
CREATE UNIQUE INDEX "PokerHand_tableId_handNumber_key" ON "PokerHand"("tableId", "handNumber");

-- AddForeignKey
ALTER TABLE "ChipLedgerEntry" ADD CONSTRAINT "ChipLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerHand" ADD CONSTRAINT "PokerHand_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
