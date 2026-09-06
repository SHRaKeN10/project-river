-- Voluntary UTG straddle for NLHE cash tables (ADR-0027).

ALTER TABLE "PokerTable"
  ADD COLUMN "straddleEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "straddleMultiplier" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "PokerTableSeat"
  ADD COLUMN "straddleOn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PokerHand"
  ADD COLUMN "straddleAmount" INTEGER NOT NULL DEFAULT 0;

-- Existing NLHE cash tables allow straddling at the standard 2x cadence.
UPDATE "PokerTable" SET "straddleEnabled" = true WHERE "gameType" = 'NLHE';
