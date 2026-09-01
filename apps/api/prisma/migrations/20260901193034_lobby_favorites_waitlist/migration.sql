-- AlterTable
ALTER TABLE "PokerTable" ADD COLUMN     "handsPlayed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "potSum" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TableFavorite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableWaitlistEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tableId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableFavorite_userId_idx" ON "TableFavorite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TableFavorite_userId_tableId_key" ON "TableFavorite"("userId", "tableId");

-- CreateIndex
CREATE INDEX "TableWaitlistEntry_tableId_createdAt_idx" ON "TableWaitlistEntry"("tableId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TableWaitlistEntry_tableId_userId_key" ON "TableWaitlistEntry"("tableId", "userId");

-- AddForeignKey
ALTER TABLE "TableFavorite" ADD CONSTRAINT "TableFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableFavorite" ADD CONSTRAINT "TableFavorite_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableWaitlistEntry" ADD CONSTRAINT "TableWaitlistEntry_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "PokerTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableWaitlistEntry" ADD CONSTRAINT "TableWaitlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
