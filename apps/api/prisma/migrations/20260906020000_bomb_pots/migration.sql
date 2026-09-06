-- Bomb pots for NLHE cash tables (ADR-0026).

ALTER TABLE "PokerTable"
  ADD COLUMN "bombPotEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bombPotIntervalHands" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "bombPotAmount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "handsSinceLastBomb" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PokerHand"
  ADD COLUMN "bombPotAmount" INTEGER NOT NULL DEFAULT 0;

-- Existing NLHE cash tables opt in to bomb pots at the default cadence.
UPDATE "PokerTable" SET "bombPotEnabled" = true WHERE "gameType" = 'NLHE';
