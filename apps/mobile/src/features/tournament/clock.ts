import { useEffect, useRef, useState } from 'react';
import type { TournamentClockState } from '@river/shared-types';

/**
 * The tournament clock is server-authoritative but the client renders it
 * locally: the server sends a snapshot (`levelEndsAt`, `serverNow`) on watch,
 * on every blind change, and after each hand-for-hand round, and the phone
 * counts down from there - resynchronising whenever a fresh snapshot lands.
 * There is no per-second server broadcast.
 */

/** `mm:ss` (or `h:mm:ss` past an hour), clamped at zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Millis left on the current level. `skewMs` (= `serverNow - clientNow` at the
 * moment the snapshot arrived) corrects for a device clock that disagrees with
 * the server. `null` once the final level is reached (it has no end).
 */
export function levelRemainingMs(
  levelEndsAt: number | null,
  skewMs: number,
  clientNow: number,
): number | null {
  if (levelEndsAt === null) return null;
  return levelEndsAt - (clientNow + skewMs);
}

/** A short blinds string: `100/200` or `100/200 (200)` with an ante. */
export function blindsLabel(
  clock: Pick<TournamentClockState, 'smallBlind' | 'bigBlind' | 'ante'>,
): string {
  return `${clock.smallBlind}/${clock.bigBlind}${clock.ante ? ` (${clock.ante})` : ''}`;
}

/**
 * A live countdown (millis) for the level, ticking once a second and
 * re-syncing every time a new snapshot arrives. `null` before the clock exists
 * or on the final level. Self-heals after the app is backgrounded: the next
 * tick recomputes from the wall clock.
 */
export function useLevelCountdown(clock: TournamentClockState | null): number | null {
  const [, forceTick] = useState(0);
  const skewRef = useRef(0);
  const syncKeyRef = useRef('');

  // Capture the client/server skew whenever a fresh snapshot lands (render-phase
  // derive-from-props - no effect lag).
  const syncKey = clock ? `${clock.serverNow}:${clock.level}:${clock.levelEndsAt}` : '';
  if (clock && syncKey !== syncKeyRef.current) {
    syncKeyRef.current = syncKey;
    skewRef.current = clock.serverNow - Date.now();
  }

  const ticking = clock !== null && clock.levelEndsAt !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => forceTick((n) => (n + 1) % 1_000_000), 1_000);
    return () => clearInterval(id);
  }, [ticking, syncKey]);

  if (!clock) return null;
  return levelRemainingMs(clock.levelEndsAt, skewRef.current, Date.now());
}
