/**
 * @river/poker-engine - pure, deterministic poker rules engine.
 *
 * Hold'em (no-limit) and four-card Pot-Limit Omaha, selected per table via
 * `config.variant` (see `GameVariant` / `rulesFor`). Hold'em is the default and
 * behaves exactly as it always has.
 *
 * The only entry point you normally need is `reduce(state, action, rng)`:
 *
 *   import { initGameState, reduce, CryptoRandomProvider } from '@river/poker-engine';
 *   let state = initGameState({ tableId, config, players });
 *   ({ state } = reduce(state, { type: 'START_HAND', handId, handNumber, previousPositions: null },
 *                       new CryptoRandomProvider()));
 *
 * Pure and total - an illegal action produces an ACTION_REJECTED event and no
 * state change; all randomness comes through the RandomProvider. The engine
 * never imports NestJS, Prisma, React, Socket.IO or any I/O.
 */

export * from './rng/random-provider';
export * from './cards';
export * from './deck';
export * from './shuffle';
export * from './variant';
export * from './hand-evaluator';
export * from './player';
export * from './table';
export * from './betting';
export * from './action-validator';
export * from './game-state';
export * from './pot-manager';
export * from './street-manager';
export * from './showdown';
export * from './events';
export * from './reducer';
export * from './tournament';

/** Semver of the engine's public contract. */
export const ENGINE_VERSION = '0.1.0';
