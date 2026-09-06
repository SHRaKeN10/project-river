-- Anti-ratholing for cash tables (ADR-0029).

ALTER TABLE "PokerTable"
  ADD COLUMN "antiRatholeMinutes" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "TableDeparture" (
  "id"      UUID NOT NULL DEFAULT gen_random_uuid(),
  "tableId" UUID NOT NULL,
  "userId"  UUID NOT NULL,
  "stack"   INTEGER NOT NULL,
  "leftAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TableDeparture_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TableDeparture_tableId_userId_key" ON "TableDeparture"("tableId", "userId");
CREATE INDEX "TableDeparture_userId_idx" ON "TableDeparture"("userId");

ALTER TABLE "TableDeparture"
  ADD CONSTRAINT "TableDeparture_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TableDeparture"
  ADD CONSTRAINT "TableDeparture_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
