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
  // Pot-Limit Omaha - four hole cards, exactly two play.
  { name: 'Bronze PLO', gameType: 'PLO', smallBlind: 5, bigBlind: 10, maxSeats: 6 },
  { name: 'Silver PLO', gameType: 'PLO', smallBlind: 10, bigBlind: 20, maxSeats: 6 },
  // "Big O" - five-card Omaha, eight-or-better hi/lo split. Max 8 seats.
  { name: 'Silver Big O', gameType: 'OMAHA5_HILO', smallBlind: 10, bigBlind: 20, maxSeats: 6 },
];

// A flat per-seat charge every 15 minutes - the membership-club billing model
// (Texas Card House/Hijack) instead of a pot rake. Our chip blinds already
// read as real-money-equivalent stakes (1 chip == $0.01), so this is the
// house's own published hourly rate card, by blind level, converted straight
// across: rate/hr -> rate/15min, rounded to the nearest chip. A table's rate
// is the card's first tier at or above its big blind (so anything below the
// card's lowest tier - e.g. a beginner room - still gets that lowest rate).
const HOURLY_RATE_CARD = [
  { bigBlind: 5, hourlyRate: 150 }, // $.02/$.05
  { bigBlind: 10, hourlyRate: 250 }, // $.05/$.10
  { bigBlind: 20, hourlyRate: 350 }, // $.10/$.20
  { bigBlind: 50, hourlyRate: 500 }, // $.25/$.50
  { bigBlind: 100, hourlyRate: 600 }, // $.50/$1
  { bigBlind: 200, hourlyRate: 750 }, // $1/$2
  { bigBlind: 400, hourlyRate: 900 }, // $2/$4
  { bigBlind: 600, hourlyRate: 1100 }, // $3/$6
  { bigBlind: 800, hourlyRate: 1200 }, // $4/$8
  { bigBlind: 1000, hourlyRate: 1400 }, // $5/$10
  { bigBlind: 2000, hourlyRate: 2000 }, // $10/$20
];
const TIME_CHARGE_INTERVAL_MS = 15 * 60_000;
const CHARGES_PER_HOUR = 3_600_000 / TIME_CHARGE_INTERVAL_MS;

const timeChargeFor = (bigBlind) => {
  const tier =
    HOURLY_RATE_CARD.find((row) => row.bigBlind >= bigBlind) ??
    HOURLY_RATE_CARD[HOURLY_RATE_CARD.length - 1];
  return {
    timeChargeAmount: Math.round(tier.hourlyRate / CHARGES_PER_HOUR),
    timeChargeIntervalMs: TIME_CHARGE_INTERVAL_MS,
  };
};

async function main() {
  for (const t of LADDER) {
    const charge = timeChargeFor(t.bigBlind);
    const existing = await prisma.pokerTable.findFirst({ where: { name: t.name } });
    if (existing) {
      await prisma.pokerTable.update({
        where: { id: existing.id },
        data: { ...charge, gameType: t.gameType ?? 'NLHE' },
      });
      console.log(`· ${t.name} — already present (config backfilled)`);
      continue;
    }
    await prisma.pokerTable.create({
      data: {
        name: t.name,
        gameType: t.gameType ?? 'NLHE',
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
    console.log(
      `+ ${t.name} — ${t.gameType ?? 'NLHE'} ${t.smallBlind}/${t.bigBlind}, ${t.maxSeats}-max`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
