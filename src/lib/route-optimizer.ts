/**
 * Route optimizer using the OSRM Table API.
 *
 * Given a set of stops with coordinates and time slots (morning/afternoon/evening),
 * reorders the stops within each time window to minimize total travel time,
 * while strictly preserving the time-window order (morning → afternoon → evening).
 */

import type { MapPoint } from '../agents/transport';

export type TimeSlot = 'morning' | 'afternoon' | 'evening';

export interface OptimizableStop extends MapPoint {
  name: string;
  timeSlot: TimeSlot;
}

export interface OptimizedStop extends MapPoint {
  name: string;
  timeSlot: TimeSlot;
  order: number;
}

const FETCH_TIMEOUT_MS = 5000;
const SLOT_ORDER: Record<TimeSlot, number> = { morning: 0, afternoon: 1, evening: 2 };

/**
 * Fetch a driving-time matrix from the OSRM Table API.
 * Returns durations in seconds; entry [i][j] is the time from stop i to stop j.
 * Returns null on failure.
 */
async function getOSRMDurationMatrix(stops: MapPoint[]): Promise<number[][] | null> {
  if (stops.length < 2) return null;
  try {
    const coords = stops.map((s) => `${s.lon},${s.lat}`).join(';');
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'flight-deal-dashboard/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.durations || !Array.isArray(data.durations)) return null;
    return data.durations as number[][];
  } catch {
    return null;
  }
}

/**
 * Solve a small TSP within a single time window using a nearest-neighbor
 * heuristic starting from the last stop of the previous window (if any).
 *
 * @param windowStops  Stops in the current time window (unordered).
 * @param matrix       Full duration matrix for all stops.
 * @param globalIndex  Function mapping a window stop to its index in the matrix.
 * @param startIndex   Matrix index of the anchor stop (last stop of previous window), or -1 to start from the first window stop.
 * @returns Ordered stops for this window.
 */
function optimizeWindow(
  windowStops: { stop: OptimizableStop; matrixIdx: number }[],
  matrix: number[][],
  startIndex: number,
): { stop: OptimizableStop; matrixIdx: number }[] {
  if (windowStops.length <= 1) return windowStops;

  const remaining = [...windowStops];
  const ordered: { stop: OptimizableStop; matrixIdx: number }[] = [];

  // Pick the starting stop: the one closest to the anchor (if provided).
  if (startIndex >= 0 && remaining.length > 1) {
    let best = 0;
    let bestTime = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const t = matrix[startIndex][remaining[i].matrixIdx];
      if (typeof t === 'number' && t < bestTime) {
        best = i;
        bestTime = t;
      }
    }
    ordered.push(remaining.splice(best, 1)[0]);
  } else {
    ordered.push(remaining.splice(0, 1)[0]);
  }

  // Greedy nearest-neighbor.
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1].matrixIdx;
    let best = 0;
    let bestTime = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const t = matrix[last][remaining[i].matrixIdx];
      if (typeof t === 'number' && t < bestTime) {
        best = i;
        bestTime = t;
      }
    }
    ordered.push(remaining.splice(best, 1)[0]);
  }

  return ordered;
}

/**
 * Reorder stops to minimize travel time while strictly anchoring them to
 * their assigned time windows. Morning stops always come before afternoon
 * stops, which always come before evening stops.
 *
 * @param stops  The day's stops with coordinates, names, and time slots.
 * @returns       The reordered stops with sequential `order` fields, or the
 *                original order if optimization fails (e.g. OSRM is down).
 */
export async function optimizeDayRoute(stops: OptimizableStop[]): Promise<OptimizedStop[]> {
  if (stops.length <= 2) {
    // Nothing to optimize — return as-is with sequential order.
    return stops.map((s, i) => ({ ...s, order: i + 1 }));
  }

  // Group stops by time slot, preserving the strict window order.
  const bySlot: Record<TimeSlot, { stop: OptimizableStop; matrixIdx: number }[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };

  // Assign matrix indices in the original order.
  stops.forEach((stop, idx) => {
    const slot = stop.timeSlot in SLOT_ORDER ? stop.timeSlot : 'morning';
    bySlot[slot].push({ stop, matrixIdx: idx });
  });

  const matrix = await getOSRMDurationMatrix(stops);
  if (!matrix) {
    // Fallback: return original order grouped by time slot.
    const fallback: OptimizedStop[] = [];
    let order = 1;
    for (const slot of ['morning', 'afternoon', 'evening'] as TimeSlot[]) {
      for (const entry of bySlot[slot]) {
        fallback.push({ ...entry.stop, timeSlot: slot, order: order++ });
      }
    }
    return fallback;
  }

  const ordered: { stop: OptimizableStop; matrixIdx: number }[] = [];
  let lastIndex = -1;

  for (const slot of ['morning', 'afternoon', 'evening'] as TimeSlot[]) {
    const window = bySlot[slot];
    if (window.length === 0) continue;
    const optimized = optimizeWindow(window, matrix, lastIndex);
    ordered.push(...optimized);
    lastIndex = optimized[optimized.length - 1].matrixIdx;
  }

  return ordered.map((entry, i) => ({
    ...entry.stop,
    timeSlot: entry.stop.timeSlot in SLOT_ORDER ? entry.stop.timeSlot : 'morning',
    order: i + 1,
  }));
}

/**
 * Parse a day block from the itinerary to extract stops with their time slots.
 * Looks for **🌅 Morning:**, **🌞 Afternoon:**, **🌙 Evening:** sections and
 * extracts bold landmark names within each.
 *
 * @param dayBlock  The markdown text for a single day.
 * @returns         Stops with coordinates unknown (lat/lon filled later by geocoding).
 */
export function extractStopsWithTimeSlots(dayBlock: string): { name: string; timeSlot: TimeSlot }[] {
  // Split the day block into time-slot sections.
  const slotPattern = /\*\*(?:🌅\s*)?Morning:?\s*\*\*([\s\S]*?)(?=\*\*(?:🌞\s*)?Afternoon:?\s*\*\*|$)/i;
  const afternoonPattern = /\*\*(?:🌞\s*)?Afternoon:?\s*\*\*([\s\S]*?)(?=\*\*(?:🌙\s*)?Evening:?\s*\*\*|$)/i;
  const eveningPattern = /\*\*(?:🌙\s*)?Evening:?\s*\*\*([\s\S]*?)(?=\*\*(?:🌅\s*)?Morning:?\s*\*|$)/i;

  const morningMatch = dayBlock.match(slotPattern);
  const afternoonMatch = dayBlock.match(afternoonPattern);
  const eveningMatch = dayBlock.match(eveningPattern);

  const stops: { name: string; timeSlot: TimeSlot }[] = [];
  const seen = new Set<string>();

  const extractBold = (text: string, slot: TimeSlot) => {
    // Image placeholders are explicit landmarks.
    for (const m of text.matchAll(/!\[IMAGE:\s*([^\]]+)\]/g)) {
      const name = m[1].trim();
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        stops.push({ name, timeSlot: slot });
      }
    }
    // Bold text.
    for (const m of text.matchAll(/\*\*(.*?)\*\*/g)) {
      const name = m[1].trim();
      if (name.length < 3) continue;
      if (/^(morning|afternoon|evening|lunch|dinner|breakfast|snack)$/i.test(name)) continue;
      if (/\b(line|subway|metro|train|railway|station|airport|bus|taxi|walk|transfer|fare|ticket|pass)\b/i.test(name)) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        stops.push({ name, timeSlot: slot });
      }
    }
  };

  if (morningMatch) extractBold(morningMatch[1], 'morning');
  if (afternoonMatch) extractBold(afternoonMatch[1], 'afternoon');
  if (eveningMatch) extractBold(eveningMatch[1], 'evening');

  return stops;
}
