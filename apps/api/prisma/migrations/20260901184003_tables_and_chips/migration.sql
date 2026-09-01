-- CreateEnum
CREATE TYPE "PokerGameType" AS ENUM ('NLHE');

-- CreateEnum
CREATE TYPE "PokerTableStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CLOSED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "playChips" INTEGER NOT NULL DEFAULT 10000;

-- CreateTable
CREATE TABLE "PokerTable" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "gameType" "PokerGameType" NOT NULL DEFAULT 'NLHE',
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "ante" INTEGER NOT NULL DEFAULT 0,
    "maxSeats" INTEGER NOT NULL DEFAULT 9,
    "minBuyIn" INTEGER NOT NULL,
    "maxBuyIn" INTEGER NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "status" "PokerTableStatus" NOT NULL DEFAULT 'ACTIVE',
    "handNumber" INTEGER NOT NULL DEFAULT 0,
    "buttonSeat" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PokerTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PokerTableSeat" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tableId" UUID NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "userId" UUID,
    "stack" INTEGER NOT NULL DEFAULT 0,
    "sittingOut" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PokerTableSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PokerTable_status_idx" ON "PokerTable"("status");

-- CreateIndex
CREATE INDEX "PokerTableSeat_userId_idx" ON "PokerTableSeat"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PokerTableSeat_tableId_seatNumber_key" ON "PokerTableSeat"("tableId", "seatNumber");

-- AddForeignKey
ALTER TABLE "PokerTableSeat" ADD CONSTRAINT "PokerTableSeat_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerTableSeat" ADD CONSTRAINT "PokerTableSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
