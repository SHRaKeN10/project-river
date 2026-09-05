import { PrismaClient } from '@prisma/client';

/**
 * Seeds the standard free-play cash-game ladder. Idempotent: tables are keyed
 * by name, so re-running only fills gaps. Plain .mjs (no ts-node) so it also
 * runs inside the production image: `node prisma/seed.mjs`.
 */
const prisma = new PrismaClient();

const LADDER = [
  { name: 'Rookie Room', smallBlind: 1, bigBlind: 2, maxSeats: 6 },
  { name: 'Bronze Stakes', smallBlind: 5, bigBlind: 10, maxSeats: 6 },
  { name: 'Bronze Stakes 9-max', smallBlind: 5, bigBlind: 10, maxSeats: 9 },
  { name: 'Silver Stakes', smallBlind: 10, bigBlind: 20, maxSeats: 6 },
  { name: 'Gold Stakes', smallBlind: 25, bigBlind: 50, maxSeats: 6 },
  { name: 'Diamond Stakes', smallBlind: 50, bigBlind: 100, maxSeats: 9 },
];

// A flat per-seat charge every 15 minutes, scaled with stakes - the
// membership-club billing model (Texas Card House/Hijack) instead of a rake.
const TIME_CHARGE_INTERVAL_MS = 15 * 60_000;
const timeChargeFor = (bigBlind) => ({
  timeChargeAmount: bigBlind * 5,
  timeChargeIntervalMs: TIME_CHARGE_INTERVAL_MS,
});

async function main() {
  for (const t of LADDER) {
    const charge = timeChargeFor(t.bigBlind);
    const existing = await prisma.pokerTable.findFirst({ where: { name: t.name } });
    if (existing) {
      await prisma.pokerTable.update({ where: { id: existing.id }, data: charge });
      console.log(`· ${t.name} — already present (time charge backfilled)`);
      continue;
    }
    await prisma.pokerTable.create({
      data: {
        name: t.name,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        maxSeats: t.maxSeats,
        minBuyIn: t.bigBlind * 20,
        maxBuyIn: t.bigBlind * 200,
        ...charge,
        seats: {
          create: Array.from({ length: t.maxSeats }, (_, seatNumber) => ({ seatNumber })),
        },
      },
    });
    console.log(`+ ${t.name} — ${t.smallBlind}/${t.bigBlind}, ${t.maxSeats}-max`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
