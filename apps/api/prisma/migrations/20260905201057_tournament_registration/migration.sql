-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('SCHEDULED', 'REGISTERING', 'RUNNING', 'PAUSED', 'FINISHED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChipMovementReason" ADD VALUE 'TOURNAMENT_BUYIN';
ALTER TYPE "ChipMovementReason" ADD VALUE 'TOURNAMENT_REFUND';
ALTER TYPE "ChipMovementReason" ADD VALUE 'TOURNAMENT_PAYOUT';

-- CreateTable
CREATE TABLE "Tournament" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "gameType" "PokerGameType" NOT NULL DEFAULT 'NLHE',
    "status" "TournamentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "buyIn" INTEGER NOT NULL,
    "entryFee" INTEGER NOT NULL DEFAULT 0,
    "startingStack" INTEGER NOT NULL,
    "seatsPerTable" INTEGER NOT NULL DEFAULT 9,
    "blindsJson" JSONB NOT NULL,
    "lateRegUntilLevel" INTEGER NOT NULL DEFAULT 1,
    "maxEntrants" INTEGER,
    "startedAt" TIMESTAMP(3),
    "pausedMs" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "resultsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournamentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seatTableId" UUID,
    "seatNumber" INTEGER,
    "stack" INTEGER NOT NULL DEFAULT 0,
    "eliminatedAt" TIMESTAMP(3),
    "finishPosition" INTEGER,
    "payout" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TournamentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tournament_status_idx" ON "Tournament"("status");

-- CreateIndex
CREATE INDEX "TournamentEntry_tournamentId_idx" ON "TournamentEntry"("tournamentId");

-- CreateIndex
CREATE INDEX "TournamentEntry_userId_idx" ON "TournamentEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEntry_tournamentId_userId_key" ON "TournamentEntry"("tournamentId", "userId");

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
