-- Run It Twice for NLHE cash tables (ADR-0028).

ALTER TABLE "PokerTable"
  ADD COLUMN "runItTwiceEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PokerTableSeat"
  ADD COLUMN "runItTwiceOn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PokerHand"
  ADD COLUMN "ranItTwice" BOOLEAN NOT NULL DEFAULT false;

-- Existing NLHE cash tables offer Run It Twice.
UPDATE "PokerTable" SET "runItTwiceEnabled" = true WHERE "gameType" = 'NLHE';
