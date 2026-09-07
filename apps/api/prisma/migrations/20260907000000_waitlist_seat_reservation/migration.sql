-- Waitlist auto-seat: a short-lived hold on one physical seat for the head of
-- a table's waitlist (ADR-0031).

CREATE TABLE "TableSeatReservation" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tableId"    UUID NOT NULL,
  "userId"     UUID NOT NULL,
  "seatNumber" INTEGER NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TableSeatReservation_pkey" PRIMARY KEY ("id")
);

-- one hold per physical seat: the concurrency guard against a double promotion
CREATE UNIQUE INDEX "TableSeatReservation_tableId_seatNumber_key"
  ON "TableSeatReservation"("tableId", "seatNumber");
-- one hold per user per table
CREATE UNIQUE INDEX "TableSeatReservation_tableId_userId_key"
  ON "TableSeatReservation"("tableId", "userId");
CREATE INDEX "TableSeatReservation_expiresAt_idx"
  ON "TableSeatReservation"("expiresAt");

ALTER TABLE "TableSeatReservation"
  ADD CONSTRAINT "TableSeatReservation_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TableSeatReservation"
  ADD CONSTRAINT "TableSeatReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
