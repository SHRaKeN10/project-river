import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  CryptoRandomProvider,
  createTableConfig,
  type GameState,
  type PreviousPositions,
} from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { type RunnerNotification, TableRunner, realTimers } from './table-runner';
import type { TableMeta } from './table-projection';
import { TablesService } from './tables.service';

const SNAPSHOT_TTL_SECONDS = 2 * 60 * 60;

type ManagerListener = (
  tableId: string,
  notification: RunnerNotification,
  runner: TableRunner,
) => void;

interface Snapshot {
  state: GameState;
  handNumber: number;
  previousPositions: PreviousPositions | null;
  roster: {
    seatNumber: number;
    userId: string;
    username: string;
    avatarUrl: string | null;
    stack: number;
    sittingOut: boolean;
  }[];
}

/**
 * Owns one `TableRunner` per active table (single-writer actors). All the
 * gateway does is look a runner up, push a command, and forward its
 * notifications on to sockets.
 */
@Injectable()
export class TableManager implements OnModuleDestroy {
  private readonly logger = new Logger(TableManager.name);
  private readonly runners = new Map<string, TableRunner>();
  private readonly creating = new Map<string, Promise<TableRunner>>();
  private readonly listeners = new Set<ManagerListener>();

  constructor(
    private readonly tables: TablesService,
    private readonly chips: ChipsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  onModuleDestroy(): void {
    for (const runner of this.runners.values()) runner.dispose();
    this.runners.clear();
  }

  subscribe(listener: ManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRunner(tableId: string): TableRunner | undefined {
    return this.runners.get(tableId);
  }

  async getOrCreate(tableId: string): Promise<TableRunner> {
    const existing = this.runners.get(tableId);
    if (existing) return existing;
    const pending = this.creating.get(tableId);
    if (pending) return pending;

    const promise = this.build(tableId).finally(() => this.creating.delete(tableId));
    this.creating.set(tableId, promise);
    return promise;
  }

  private async build(tableId: string): Promise<TableRunner> {
    const table = await this.tables.get(tableId);
    const meta: TableMeta = {
      id: table.id,
      name: table.name,
      gameType: table.gameType,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      maxSeats: table.maxSeats,
      minBuyIn: table.minBuyIn,
      maxBuyIn: table.maxBuyIn,
    };
    const engineConfig = createTableConfig({
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      ante: table.ante,
      maxSeats: table.maxSeats,
      minBuyIn: table.minBuyIn,
      maxBuyIn: table.maxBuyIn,
    });

    const runner = new TableRunner(meta, engineConfig, {
      rng: new CryptoRandomProvider(),
      timers: realTimers,
      now: () => Date.now(),
      config: {
        actionTimeoutMs: this.config.get('TABLE_ACTION_TIMEOUT_MS'),
        nextHandDelayMs: this.config.get('TABLE_NEXT_HAND_DELAY_MS'),
        startDelayMs: this.config.get('TABLE_START_DELAY_MS'),
        disconnectGraceMs: this.config.get('TABLE_DISCONNECT_GRACE_MS'),
      },
      notify: (notification) => {
        this.emit(tableId, notification, runner);
        void this.persistSnapshot(tableId, runner);
      },
      persistRoster: (r) => {
        void this.tables
          .syncSeats(tableId, r.rosterSnapshot(), r.lastHandNumber, r.lastPositions)
          .catch((err) => this.logger.error(`syncSeats ${tableId}: ${(err as Error).message}`));
      },
      onSeatVacated: (userId, stack) => {
        void this.chips
          .credit(userId, stack)
          .catch((err) => this.logger.error(`credit ${userId}: ${(err as Error).message}`));
        this.emit(tableId, { kind: 'seatVacated' }, runner);
      },
      recordHandStats: (potTotal) => {
        void this.prisma.pokerTable
          .update({
            where: { id: tableId },
            data: { handsPlayed: { increment: 1 }, potSum: { increment: potTotal } },
          })
          .catch((err) => this.logger.warn(`stats ${tableId}: ${(err as Error).message}`));
      },
    });

    await this.hydrate(runner, table);
    this.runners.set(tableId, runner);
    return runner;
  }

  private async hydrate(
    runner: TableRunner,
    table: Awaited<ReturnType<TablesService['get']>>,
  ): Promise<void> {
    const snapshot = await this.readSnapshot(table.id);
    const seatUserIds = (snapshot?.roster.map((r) => r.userId) ??
      table.seats.filter((s) => s.userId).map((s) => s.userId as string)) as string[];

    const users = await this.prisma.user.findMany({
      where: { id: { in: seatUserIds } },
      select: { id: true, username: true, avatarUrl: true },
    });
    const userMeta = new Map(
      users.map((u) => [u.id, { username: u.username, avatarUrl: u.avatarUrl }]),
    );

    if (snapshot) {
      runner.hydrateFromSnapshot(snapshot, userMeta);
    } else {
      runner.hydrate(
        table.seats.map((s) => ({
          seatNumber: s.seatNumber,
          userId: s.userId,
          stack: s.stack,
          sittingOut: s.sittingOut,
        })),
        userMeta,
        table.handNumber,
        table.buttonSeat === null
          ? null
          : {
              buttonSeat: table.buttonSeat,
              smallBlindSeat: table.smallBlindSeat,
              bigBlindSeat: table.bigBlindSeat ?? table.buttonSeat,
            },
      );
    }
  }

  private emit(tableId: string, notification: RunnerNotification, runner: TableRunner): void {
    for (const listener of this.listeners) {
      try {
        listener(tableId, notification, runner);
      } catch (err) {
        this.logger.error(`listener error: ${(err as Error).message}`);
      }
    }
  }

  private async persistSnapshot(tableId: string, runner: TableRunner): Promise<void> {
    try {
      const snapshot: Snapshot = {
        state: runner.gameState,
        handNumber: runner.lastHandNumber,
        previousPositions: runner.lastPositions,
        roster: [...runner.rosterEntries.entries()].map(([seatNumber, e]) => ({
          seatNumber,
          userId: e.userId,
          username: e.username,
          avatarUrl: e.avatarUrl,
          stack: e.stack,
          sittingOut: e.sittingOut,
        })),
      };
      await this.redis.client.set(
        this.snapshotKey(tableId),
        JSON.stringify(snapshot),
        'EX',
        SNAPSHOT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`snapshot ${tableId}: ${(err as Error).message}`);
    }
  }

  private async readSnapshot(tableId: string): Promise<Snapshot | null> {
    try {
      const raw = await this.redis.client.get(this.snapshotKey(tableId));
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {
      return null;
    }
  }

  private snapshotKey(tableId: string): string {
    return `table:${tableId}:snapshot`;
  }
}
