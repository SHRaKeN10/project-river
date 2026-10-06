import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableStateView } from '@river/shared-types';
import { diffFlights, snapshotOf, type FlightSpec, type TableSnap } from './chipFlights';

export interface Flight extends FlightSpec {
  id: string;
}

/** Watches the table view and returns the chip animations to draw right now.
 * Call `done(id)` when one finishes so it is dropped. */
export function useChipFlights(view: TableStateView | null): {
  flights: Flight[];
  done: (id: string) => void;
} {
  const prev = useRef<TableSnap | null>(null);
  const counter = useRef(0);
  const [flights, setFlights] = useState<Flight[]>([]);

  useEffect(() => {
    if (!view) return;
    const next = snapshotOf(view);
    const specs = diffFlights(prev.current, next);
    prev.current = next;
    if (specs.length === 0) return;
    const fresh = specs.map((s) => {
      counter.current += 1;
      return { ...s, id: `f${counter.current}` };
    });
    setFlights((cur) => [...cur, ...fresh]);
  }, [view]);

  const done = useCallback((id: string) => setFlights((cur) => cur.filter((f) => f.id !== id)), []);

  return { flights, done };
}
