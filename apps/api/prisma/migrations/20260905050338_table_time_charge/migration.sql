-- AlterTable
ALTER TABLE "PokerTable" ADD COLUMN     "timeChargeAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timeChargeIntervalMs" INTEGER NOT NULL DEFAULT 0;
