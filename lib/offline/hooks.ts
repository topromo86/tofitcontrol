"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import * as connection from "@/lib/offline/connection";
import * as queue from "@/lib/offline/queue";

// Stan łącza i kolejka to stan ZEWNĘTRZNY wobec Reacta (zdarzenia okna,
// localStorage, ping w tle), więc czytamy je przez useSyncExternalStore - tak
// samo jak motyw w app/theme-toggle.tsx. Bez tego trzeba by trzymać kopię
// w useState i pilnować jej w efektach.

export function useConnection(): connection.ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState, connection.getServerState);
}

export function useOfflineQueue() {
  return useSyncExternalStore(queue.subscribe, queue.getEntries, queue.getServerEntries);
}

// Podpis "OFFLINE · od 12 min" musi się odświeżać, nawet gdy nic się nie
// dzieje - inaczej pasek zastyga na "przed chwilą" i wygląda, jakby zamarł.
export function useMinuteTick(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return tick;
}
