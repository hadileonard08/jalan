import { geocode } from '../agents/transport';

// "Is this place open, and when does it close?"
//
// Nothing in the pipeline answered that: the guardrails only confirmed a venue
// *exists*, and the Critic has no opening-status context to judge. SIFF Cinema
// Egyptian — permanently closed — passed every check.
//
// Primary source is OpenStreetMap via Overpass: one bulk request covers every
// venue in a trip and returns structured answers, not prose —
//
//   node 2158750787  name="SIFF Cinema Egyptian"
//     disused:amenity = <present>
//     opening_hours   = "Closed indefinitely due to water damage."
//     check_date      = 2025-09-14
//
// Wikipedia is kept as a fallback for venues OSM doesn't know (it catches the
// same case in prose, at the cost of two requests per venue and heavy 429s).
//
// Everything here is ADVISORY: it is shown to a person and never triggers a
// regeneration, because OSM coverage is uneven and the data is mapper-maintained.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'jalan-venue-check/1.0 (itinerary venue status)';

export interface VenueStatus {
  name: string;
  /** Evidence the venue has closed, when the data says so. */
  closed?: string;
  /** Raw OSM `opening_hours`, when present. */
  openingHours?: string;
  /** Where the answer came from, for the message. */
  source: 'osm' | 'wikipedia';
}

// OSM keys that mean "this thing is not in use".
const CLOSURE_TAG_PREFIXES = ['disused:', 'abandoned:', 'was:', 'demolished:', 'razed:'];
const CLOSED_HOURS_TEXT = /\b(?:closed|permanently closed|no longer|ceased)\b/i;

function closureEvidence(tags: Record<string, string>): string | null {
  for (const key of Object.keys(tags)) {
    if (CLOSURE_TAG_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return `OpenStreetMap tags it as "${key}" (out of use)`;
    }
  }
  if (tags.end_date) return `OpenStreetMap records an end date of ${tags.end_date}`;
  if (tags.opening_hours && CLOSED_HOURS_TEXT.test(tags.opening_hours)) {
    return `OpenStreetMap says: "${tags.opening_hours.trim().slice(0, 160)}"`;
  }
  return null;
}

/**
 * One Overpass request for every venue name. The union query is what makes this
 * cheap: N venues cost one round trip rather than N.
 */
async function fetchFromOsm(names: string[], destination?: string): Promise<Map<string, VenueStatus>> {
  const found = new Map<string, VenueStatus>();
  if (names.length === 0) return found;

  // Scope the search to the destination so common names don't match elsewhere.
  let around = '';
  if (destination) {
    const point = await geocode(destination, destination).catch(() => null);
    if (point) around = `(around:40000,${point.lat},${point.lon})`;
  }

  const clauses = names
    .map((name) => `nwr["name"="${name.replace(/"/g, '')}"]${around};`)
    .join('\n  ');

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: `[out:json][timeout:25];\n(\n  ${clauses}\n);\nout tags center;` }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return found;

    const data = (await res.json()) as {
      elements?: { tags?: Record<string, string> }[];
    };
    for (const [name, status] of mergeVenueElements(names, data.elements || [])) {
      found.set(name, status);
    }
  } catch {
    // Overpass is fair-use and throttles; silence beats a wrong answer.
  }

  return found;
}

/**
 * Folds Overpass elements onto the names that were asked for.
 *
 * A name often matches several elements — the Space Needle is both a tower and a
 * building outline, and only one carries `opening_hours` — so tags are merged
 * rather than keeping whichever element happened to come back first.
 */
export function mergeVenueElements(
  names: string[],
  elements: { tags?: Record<string, string> }[],
): Map<string, VenueStatus> {
  const merged = new Map<string, VenueStatus>();
  for (const element of elements) {
    const tags = element.tags || {};
    const name = tags.name;
    if (!name) continue;
    const requested = names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!requested) continue;

    const existing = merged.get(requested);
    merged.set(requested, {
      name: requested,
      closed: closureEvidence(tags) || existing?.closed,
      openingHours: tags.opening_hours || existing?.openingHours,
      source: 'osm',
    });
  }
  return merged;
}

// --- Wikipedia fallback -----------------------------------------------------

const CLOSED_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bpermanently closed\b/i, label: 'is described as permanently closed' },
  { pattern: /\bclosed\s+(?:indefinitely|permanently|temporarily)\b/i, label: 'closed' },
  { pattern: /\bclosed\s+(?:in|since)\s+(?:[A-Z][a-z]+\s+)?\d{4}\b/i, label: 'closed' },
  { pattern: /\bwill not (?:reopen|continue)\b/i, label: 'is not reopening' },
  { pattern: /\bceased operations\b/i, label: 'ceased operations' },
  { pattern: /\bno longer (?:operat|open|in operation)/i, label: 'is no longer operating' },
  { pattern: /\bdefunct\b/i, label: 'is described as defunct' },
  { pattern: /\b(?:former|disused|abandoned)\s+(?:cinema|theater|theatre|museum|gallery|stadium|arena|market|restaurant|hotel)\b/i, label: 'is described as a former venue' },
  { pattern: /\bdemolished\b/i, label: 'was demolished' },
  { pattern: /\bwas (?:operated|run|owned) by\b/i, label: 'is written about in the past tense' },
];

// Kept deliberately narrow — a blunt `/\breopened\b/` guard suppressed the real
// closure below, because the article mentions reopening in 1980 and 2014 while
// also saying the theatre closed indefinitely in 2024.
const STILL_OPEN_PATTERNS = [
  /\bas of \d{4}\b/i,
  /\bcurrently (?:open|operating|operates|hosts|runs|home to)\b/i,
  /\bis (?:currently )?(?:operated|run|owned|managed) by\b/i,
];

const introCache = new Map<string, string | null>();

async function wikiJson(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1) * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      // A throttled response is plain text, not JSON.
      if (!text.trimStart().startsWith('{')) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

function extractFromPages(data: any): string | null {
  for (const page of Object.values(data?.query?.pages || {}) as any[]) {
    if (page.missing) continue;
    if (page.extract) return page.extract as string;
  }
  return null;
}

async function wikipediaIntro(term: string): Promise<string | null> {
  const key = term.toLowerCase();
  if (introCache.has(key)) return introCache.get(key)!;

  // The term as a title first — a redirect usually lands on the article, which
  // costs one request instead of two.
  let intro = extractFromPages(
    await wikiJson(
      `${WIKIPEDIA_API}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(term)}&format=json&origin=*`,
    ),
  );

  if (!intro) {
    const search = await wikiJson(
      `${WIKIPEDIA_API}?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=1&format=json&origin=*`,
    );
    const title = search?.query?.search?.[0]?.title;
    if (title) {
      intro = extractFromPages(
        await wikiJson(
          `${WIKIPEDIA_API}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`,
        ),
      );
    }
  }

  introCache.set(key, intro);
  return intro;
}

async function fetchFromWikipedia(names: string[]): Promise<Map<string, VenueStatus>> {
  const found = new Map<string, VenueStatus>();
  await Promise.all(
    names.map(async (name) => {
      const intro = await wikipediaIntro(name);
      if (!intro) return;
      if (STILL_OPEN_PATTERNS.some((p) => p.test(intro))) return;

      // Patterns are strongest-first, so quote the most telling one.
      const hit = CLOSED_PATTERNS.find(({ pattern }) => pattern.test(intro));
      if (!hit) return;
      const sentence = intro.split(/(?<=\.)\s+/).find((s) => hit.pattern.test(s));
      found.set(name, {
        name,
        closed: `its Wikipedia article says it ${hit.label}${sentence ? `: "${sentence.trim().slice(0, 200)}"` : ''}`,
        source: 'wikipedia',
      });
    }),
  );
  return found;
}

/**
 * Venue status for every name, OSM first with Wikipedia filling the gaps.
 * Capped: Overpass is fair-use and each miss costs a Wikipedia request.
 */
export async function fetchVenueStatus(
  names: string[],
  destination?: string,
): Promise<Map<string, VenueStatus>> {
  const unique = [...new Set(names.filter(Boolean))].slice(0, 25);
  if (unique.length === 0) return new Map();

  const fromOsm = await fetchFromOsm(unique, destination);

  // Wikipedia only for the ones OSM couldn't answer at all.
  const missing = unique.filter((name) => !fromOsm.has(name)).slice(0, 12);
  const fromWikipedia = missing.length ? await fetchFromWikipedia(missing) : new Map();

  return new Map([...fromOsm, ...fromWikipedia]);
}

// --- Opening hours ----------------------------------------------------------

/**
 * Latest closing time in minutes past midnight, when the value can be read
 * confidently. Returns null for anything ambiguous — `opening_hours` is a spec
 * of its own (`Mo-Th 09:00-22:00; Nov Th[4] off; sunrise-sunset`), and guessing
 * would be worse than staying quiet.
 */
export function latestClosingMinutes(openingHours: string): number | null {
  if (!openingHours) return null;
  // Anything using the more exotic syntax is left alone.
  if (/sunrise|sunset|dawn|dusk|\[|\]|\|\||\+|@/i.test(openingHours)) return null;

  const pairs = Array.from(openingHours.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g));
  if (pairs.length === 0) return null;

  let latest = 0;
  for (const [, , , closeHour, closeMinute] of pairs) {
    const hour = Number(closeHour);
    const minute = Number(closeMinute);
    if (hour > 24 || minute > 59) return null;
    // 00:00 as a close time means midnight, i.e. the end of the day.
    const asMinutes = hour === 0 && minute === 0 ? 24 * 60 : hour * 60 + minute;
    latest = Math.max(latest, asMinutes);
  }
  return latest;
}

function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface EveningHoursConflict {
  day: number;
  name: string;
  hours: string;
  closesAt: string;
}

/**
 * Evening stops whose real opening hours say they have shut by then. Only the
 * LATEST closing across the week is used, so day-specific early closings can't
 * produce a false positive.
 */
export function findEveningHoursConflicts(
  itinerary: string,
  statuses: Map<string, VenueStatus>,
): EveningHoursConflict[] {
  const conflicts: EveningHoursConflict[] = [];
  for (const { day, name } of findEveningStops(itinerary)) {
    const status = statuses.get(name);
    if (!status?.openingHours || status.closed) continue;
    const closes = latestClosingMinutes(status.openingHours);
    // 19:00 — a venue shutting at or before this can't host an evening stop.
    if (closes === null || closes >= 19 * 60) continue;
    conflicts.push({
      day,
      name,
      hours: status.openingHours,
      closesAt: formatClock(closes),
    });
  }
  return conflicts;
}

// --- Evening block extraction ----------------------------------------------

function splitDayBlocks(itinerary: string): { day?: number; block: string }[] {
  return itinerary
    .split(/(?=#+\s+Day\s+\d+)/i)
    .filter((block) => block.length > 0)
    .map((block) => {
      const match = block.match(/#+\s+Day\s+(\d+)/i);
      return { day: match ? Number(match[1]) : undefined, block };
    });
}

function eveningSection(dayBlock: string): string {
  const idx = dayBlock.search(/\*\*[^*]*Evening[^*]*\*\*/i);
  return idx === -1 ? '' : dayBlock.slice(idx);
}

function boldNames(text: string): string[] {
  return Array.from(text.matchAll(/\*\*([^*]+)\*\*/g))
    .map((m) => m[1].trim())
    .filter((name) => name.length > 2 && !/evening|morning|afternoon/i.test(name))
    .filter((name) => !/^\p{Emoji}/u.test(name));
}

/** Bolded stops sitting in an Evening block, with their day. */
export function findEveningStops(itinerary: string): { day: number; name: string }[] {
  const stops: { day: number; name: string }[] = [];
  for (const { day, block } of splitDayBlocks(itinerary)) {
    if (day === undefined) continue;
    for (const name of boldNames(eveningSection(block))) stops.push({ day, name });
  }
  return stops;
}

/**
 * Every stop name in the itinerary: image alts plus bolded stops.
 *
 * Reading only image alts misses any stop added by an approved edit — a patch
 * inserts bolded text without an image — so the very venues a Follower suggests
 * were the ones never checked for being closed.
 */
export function extractStopNames(itinerary: string): string[] {
  const names: string[] = [];

  for (const match of itinerary.matchAll(/!\[IMAGE:\s*([^\]]+)\]/gi)) names.push(match[1].trim());
  for (const match of itinerary.matchAll(/!\[([^\]]+)\]\([^)]*\)/g)) {
    const alt = match[1].trim();
    if (alt && !/^IMAGE:/i.test(alt)) names.push(alt);
  }

  for (const { block } of splitDayBlocks(itinerary)) {
    // Drop the injected transport note — its bold text is modes, not venues.
    const body = block.split(/\*\*[^*]*Getting around[^*]*\*\*/i)[0];
    names.push(...boldNames(body));
  }

  return [...new Set(names.filter(Boolean))];
}

/** Clears the in-process caches. Test helper. */
export function clearVenueStatusCache() {
  introCache.clear();
}
