import { PrismaClient } from '@prisma/client';

/**
 * Seeds the standard free-play cash-game ladder. Idempotent: tables are keyed
 * by name, so re-running only fills gaps. Safe to run in dev and CI.
 */
const prisma = new PrismaClient();

interface TableSeed {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
}

const LADDER: TableSeed[] = [
  { name: 'Rookie Room', smallBlind: 1, bigBlind: 2, maxSeats: 6 },
  { name: 'Bronze Stakes', smallBlind: 5, bigBlind: 10, maxSeats: 6 },
  { name: 'Bronze Stakes 9-max', smallBlind: 5, bigBlind: 10, maxSeats: 9 },
  { name: 'Silver Stakes', smallBlind: 10, bigBlind: 20, maxSeats: 6 },
  { name: 'Gold Stakes', smallBlind: 25, bigBlind: 50, maxSeats: 6 },
  { name: 'Diamond Stakes', smallBlind: 50, bigBlind: 100, maxSeats: 9 },
];

async function main(): Promise<void> {
  for (const t of LADDER) {
    const existing = await prisma.pokerTable.findFirst({ where: { name: t.name } });
    if (existing) {
      console.log(`· ${t.name} — already present`);
      continue;
    }
    const minBuyIn = t.bigBlind * 20;
    const maxBuyIn = t.bigBlind * 200;
    await prisma.pokerTable.create({
      data: {
        name: t.name,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        maxSeats: t.maxSeats,
        minBuyIn,
        maxBuyIn,
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
