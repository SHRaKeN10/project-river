# ADR-0001: Foundation stack & structure

Status: Accepted — 2026-09-01

## Context

Project River is a real-time, server-authoritative multiplayer poker platform.
V1 is free-to-play NLHE. We need a foundation that keeps the poker rules engine
completely isolated from transport, persistence, and UI, and that scales from a
single node to many without rewrites.

## Decision

- **Monorepo** with pnpm workspaces + Turborepo. Strict dependency isolation,
  cached task graph.
- **API**: NestJS modular monolith. DI container enforces the domain /
  application / infrastructure boundary. First-class Socket.IO support.
- **Poker engine**: standalone `@river/poker-engine`, pure TypeScript, no
  framework or I/O dependencies. Single public entry: `reduce(state, action, rng)`.
- **Randomness**: `RandomProvider` interface. `CryptoRandomProvider` (CSPRNG)
  for production, `SeededRandomProvider` for tests and exact hand replay.
  `Math.random()` is banned in the engine.
- **DB**: PostgreSQL + Prisma. Hand history is event-sourced (append-only) for
  replayability. Money-adjacent values are integer minor units, never floats.
- **Redis**: Socket.IO adapter, table locks, presence, rate limiting, hot-table
  snapshots for crash recovery.
- **Mobile**: React Native + Expo (managed workflow), TanStack Query (server
  state) + Zustand (high-frequency table state).
- **Table authority**: each table is a single-writer actor (`TableRunner`). All
  actions for one table are processed on a serial queue — no races. MVP runs all
  runners in the API process; multi-node sharding is added later behind the same
  interface.

## Consequences

- The engine is unit-testable in isolation with property-based and simulation
  tests; correctness work does not require infrastructure.
- Wallet / payments / compliance can be added as separate modules the tables
  module calls through an interface — the engine never learns money is real.
- Node 22 is the target; local dev also supported on Node 20.11+.
