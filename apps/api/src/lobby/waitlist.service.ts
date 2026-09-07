import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { WaitlistNoReservationError } from '../observability/error-codes';
import { OrchestrationErrorsService } from '../observability/orchestration-errors.service';

/** Set by the lobby gateway so the service can reach a specific user's socket
 * and know who is online. Absent in unit tests. */
export interface WaitlistBindings {
  /** Tell `userId` that seat `seatNumber` at `tableId` is held for them until
   * `expiresAt` (epoch ms). They claim it with a normal `table:join`. */
  notify: (userId: string, tableId: string, seatNumber: number, expiresAt: number) => void;
  /** True if the user has at least one live socket on this node. */
  isOnline: (userId: string) => boolean;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Waitlist auto-seat (ADR-0031).
 *
 * When a seat frees, the head of the table's waitlist gets a short-lived
 * **hold** on one physical seat (`TableSeatReservation`). While the hold is
 * live only that player may take that seat (`sitDown` enforces it); it is
 * consumed inside `sitDown`'s transaction on a successful claim, or swept once
 * it expires and passed to the next in line.
 *
 * The concurrency guard is the DB: `@@unique([tableId, seatNumber])` on the
 * reservation means two waitlisted players can never be promoted onto the same
 * seat, and `sitDown`'s atomic `updateMany where userId: null` means two joins
 * for one seat can never both win. Everything here is idempotent and holds no
 * in-memory timers, so a process restart just re-runs the sweeper.
 */
@Injectable()
export class WaitlistService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WaitlistService.name);
  private bindings: WaitlistBindings | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly orchestrationErrors: OrchestrationErrorsService,
  ) {}

  onModuleInit(): void {
    // An initial sweep clears any hold that expired while the process was down
    // and re-promotes; the interval keeps holds moving after that.
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.config.get('WAITLIST_SWEEP_MS'));
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  bind(bindings: WaitlistBindings): void {
    this.bindings = bindings;
  }

  private get claimWindowMs(): number {
    return this.config.get('WAITLIST_CLAIM_WINDOW_MS');
  }

  /** Called when a seat opens at a table. Fire-and-forget. */
  seatVacated(tableId: string): void {
    void this.promote(tableId);
  }

  /**
   * The reservation this user currently holds at a table, for the REST claim
   * endpoint. The actual seating happens through `table:join` with this seat
   * number (which consumes the hold). Throws if there is no live hold.
   */
  async claimInfo(
    userId: string,
    tableId: string,
  ): Promise<{ seatNumber: number; expiresAt: number }> {
    const r = await this.prisma.tableSeatReservation.findUnique({
      where: { tableId_userId: { tableId, userId } },
    });
    if (!r || r.expiresAt.getTime() <= Date.now()) throw new WaitlistNoReservationError();
    return { seatNumber: r.seatNumber, expiresAt: r.expiresAt.getTime() };
  }

  /** Drop a user's hold and hand the seat to the next in line. */
  async release(tableId: string, userId: string): Promise<void> {
    await this.prisma.tableSeatReservation
      .deleteMany({ where: { tableId, userId } })
      .catch(() => undefined);
    await this.promote(tableId);
  }

  /** Leave a table's waitlist entirely - the entry and any seat held for it -
   * then hand that seat to whoever is next. */
  async leave(userId: string, tableId: string): Promise<void> {
    await this.prisma.tableWaitlistEntry
      .deleteMany({ where: { tableId, userId } })
      .catch(() => undefined);
    await this.release(tableId, userId);
  }

  /**
   * Drop every hold that has expired, and the waitlist entry that went with it -
   * a player who lets their window lapse loses their place. Scoped to one table
   * or (no arg) all of them.
   */
  private async expireStaleHolds(tableId?: string): Promise<string[]> {
    const now = new Date();
    const expired = await this.prisma.tableSeatReservation.findMany({
      where: { expiresAt: { lt: now }, ...(tableId ? { tableId } : {}) },
      select: { tableId: true, userId: true },
    });
    for (const e of expired) {
      await this.prisma.$transaction([
        this.prisma.tableSeatReservation.deleteMany({
          where: { tableId: e.tableId, userId: e.userId },
        }),
        this.prisma.tableWaitlistEntry.deleteMany({
          where: { tableId: e.tableId, userId: e.userId },
        }),
      ]);
    }
    // safety net for a hold that raced the query
    await this.prisma.tableSeatReservation.deleteMany({
      where: { expiresAt: { lt: now }, ...(tableId ? { tableId } : {}) },
    });
    return [...new Set(expired.map((e) => e.tableId))];
  }

  /**
   * Give the next eligible waitlist head a hold on one open seat. Idempotent and
   * safe to call concurrently: a racing call loses the `create` on the unique
   * seat index and bails.
   */
  async promote(tableId: string): Promise<void> {
    try {
      await this.expireStaleHolds(tableId);

      const table = await this.prisma.pokerTable.findUnique({
        where: { id: tableId },
        select: { status: true, minBuyIn: true },
      });
      if (!table || table.status !== 'ACTIVE') return;

      const [openSeats, holds, list] = await Promise.all([
        this.prisma.pokerTableSeat.findMany({
          where: { tableId, userId: null },
          select: { seatNumber: true },
          orderBy: { seatNumber: 'asc' },
        }),
        this.prisma.tableSeatReservation.findMany({
          where: { tableId },
          select: { seatNumber: true, userId: true },
        }),
        this.prisma.tableWaitlistEntry.findMany({
          where: { tableId },
          orderBy: { createdAt: 'asc' },
          select: { userId: true },
        }),
      ]);

      if (list.length === 0) return;
      // The head of the list is already being served - one seat handed out at a
      // time, strictly in order. Wait for their hold to resolve.
      if (holds.some((h) => h.userId === list[0].userId)) return;

      const heldSeats = new Set(holds.map((h) => h.seatNumber));
      const openSeat = openSeats.map((s) => s.seatNumber).find((n) => !heldSeats.has(n));
      if (openSeat === undefined) return;

      for (const { userId } of list) {
        if (holds.some((h) => h.userId === userId)) return; // already holding one
        const seatedElsewhere = await this.prisma.pokerTableSeat.count({
          where: { tableId, userId },
        });
        if (seatedElsewhere > 0) continue; // stale waitlist row - they are seated
        if (this.bindings && !this.bindings.isOnline(userId)) continue; // offline - skip
        const wallet = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { playChips: true },
        });
        if (!wallet || wallet.playChips < table.minBuyIn) continue; // can't cover the min buy-in

        const expiresAt = new Date(Date.now() + this.claimWindowMs);
        try {
          await this.prisma.tableSeatReservation.create({
            data: { tableId, userId, seatNumber: openSeat, expiresAt },
          });
        } catch (e) {
          if (isUniqueViolation(e)) return; // a concurrent promote won the seat
          throw e;
        }
        this.bindings?.notify(userId, tableId, openSeat, expiresAt.getTime());
        this.logger.log(
          `reserved seat ${openSeat}@${tableId} for ${userId} until ${expiresAt.toISOString()}`,
        );
        return;
      }
    } catch (err) {
      this.logger.error(`promote ${tableId}: ${(err as Error).message}`);
      this.orchestrationErrors.record('waitlist-promote', err, { tableId });
    }
  }

  /**
   * Expire stale holds everywhere and re-promote any table that now needs it. A
   * player who let their window lapse **loses their place** - the hold and their
   * waitlist entry both go, and the seat passes to the next in line. They can
   * re-join the list.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const candidates = new Set(await this.expireStaleHolds());
      const waitlisted = await this.prisma.tableWaitlistEntry.findMany({
        distinct: ['tableId'],
        select: { tableId: true },
      });
      for (const { tableId } of waitlisted) candidates.add(tableId);

      for (const tableId of candidates) {
        // eslint-disable-next-line no-await-in-loop
        await this.promote(tableId);
      }
    } catch (err) {
      this.logger.error(`sweep: ${(err as Error).message}`);
      this.orchestrationErrors.record('waitlist-sweep', err);
    } finally {
      this.sweeping = false;
    }
  }
}
