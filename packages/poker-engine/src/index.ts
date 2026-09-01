/**
 * @river/poker-engine - pure, deterministic Texas Hold'em rules engine.
 *
 * PUBLIC SURFACE (grows through Phase 4):
 *   - RandomProvider abstraction              [done]
 *   - cards / deck / shuffle                  [done]
 *   - hand-evaluator                          [done]
 *   - player / table / betting / action-validator / game-state  [done]
 *   - pot-manager / street-manager / showdown / events          [next]
 *   - reduce(state, action, rng) => { state, events[] }
 *
 * The engine must never import NestJS, Prisma, React, Socket.IO or any I/O.
 */

export * from './rng/random-provider';
export * from './cards';
export * from './deck';
export * from './shuffle';
export * from './hand-evaluator';
export * from './player';
export * from './table';
export * from './betting';
export * from './action-validator';
export * from './game-state';

/** Semver of the engine's public contract. */
export const ENGINE_VERSION = '0.0.0';
