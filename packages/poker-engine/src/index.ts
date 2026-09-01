/**
 * @river/poker-engine - pure, deterministic Texas Hold'em rules engine.
 *
 * PUBLIC SURFACE (grows through Phases 3-4):
 *   - RandomProvider abstraction (this phase)
 *   - cards / deck / shuffle
 *   - hand-evaluator
 *   - reduce(state, action, rng) => { state, events[] }
 *
 * The engine must never import NestJS, Prisma, React, Socket.IO or any I/O.
 */

export * from './rng/random-provider';

/** Semver of the engine's public contract. */
export const ENGINE_VERSION = '0.0.0';
