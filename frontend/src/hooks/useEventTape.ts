'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { EVENT_LOOKBACK_LEDGERS, EVENT_POLL_MS } from '@/lib/config';
import { fetchEvents, startingLedger } from '@/lib/events';
import type { PactEvent } from '@/lib/types';

const MAX_KEPT = 60;

/**
 * Streams contract events into a live tape.
 *
 * The first poll reaches back a fixed number of ledgers so the page opens with
 * history rather than an empty box; every poll after that resumes from the
 * cursor the RPC handed back, which is what stops events being missed or
 * shown twice.
 */
export function useEventTape(enabled = true) {
  const [events, setEvents] = useState<PactEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [ledger, setLedger] = useState<number | null>(null);

  const cursor = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const page = cursor.current
        ? await fetchEvents({ cursor: cursor.current })
        : await fetchEvents({ startLedger: await startingLedger(EVENT_LOOKBACK_LEDGERS) });

      if (!alive.current) return;

      cursor.current = page.cursor ?? cursor.current;
      setLedger(page.latestLedger);
      setConnected(true);

      if (page.events.length > 0) {
        setEvents((current) => {
          const seen = new Set(current.map((event) => event.id));
          const fresh = page.events.filter((event) => !seen.has(event.id));
          if (fresh.length === 0) return current;
          // Newest first, oldest trimmed off the end.
          return [...fresh.reverse(), ...current].slice(0, MAX_KEPT);
        });
      }
    } catch {
      // A dropped poll is not worth a toast — the tape shows its own
      // connection state and the next tick will recover.
      if (alive.current) setConnected(false);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void poll();
    const timer = setInterval(() => void poll(), EVENT_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, poll]);

  return { events, connected, ledger };
}
