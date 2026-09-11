const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const FETCH_TIMEOUT_MS = 5000;
const landmarkVerificationCache = new Map<string, boolean>();

export interface RouteLink {
  day: string;
  title: string;
  highlights: string;
  url: string;
}

function extractLandmarkNames(itinerary: string): string[] {
  const matches = Array.from(itinerary.matchAll(/!\[IMAGE:\s*([^\]]+)\]/g));
  const names = matches.map((m) => m[1].trim()).filter(Boolean);
  return [...new Set(names)];
}

async function wikipediaSearchExists(term: string): Promise<boolean> {
  const headers = { 'User-Agent': 'flight-deal-dashboard/1.0 (itinerary guardrails)' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${WIKIPEDIA_API}?action=opensearch&search=${encodeURIComponent(term)}&limit=1&namespace=0&format=json&origin=*`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );
      if (res.status === 429) {
        // Rate-limited — wait and retry with exponential backoff.
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return true; // Fail open if Wikipedia is down.
      const data = (await res.json()) as [string, string[], string[], string[]];
      const results = data[1] || [];
      return results.length > 0;
    } catch (error) {
      console.error('Wikipedia guardrail check failed for', term, ':', (error as Error).message);
      return true; // Fail open.
    }
  }
  // All retries exhausted due to rate-limiting — fail open.
  return true;
}

async function openStreetMapSearchExists(term: string, destination?: string): Promise<boolean> {
  if (!destination) return false;
  try {
    const query = encodeURIComponent(`${term}, ${destination}`);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { headers: { 'User-Agent': 'jalan/1.0 (itinerary guardrails)' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.status === 429 || !res.ok) return true;
    const results = (await res.json()) as unknown[];
    return results.length > 0;
  } catch {
    return true;
  }
}

export async function verifyItineraryLandmarks(itinerary: string, destination?: string): Promise<string[]> {
  const landmarks = extractLandmarkNames(itinerary);
  if (landmarks.length === 0) return [];

  const unverified: string[] = [];
  await Promise.all(
    landmarks.map(async (name) => {
      const cacheKey = `${name.toLowerCase()}|${destination?.toLowerCase() || ''}`;
      const cached = landmarkVerificationCache.get(cacheKey);
      let exists: boolean;
      if (cached !== undefined) {
        exists = cached;
      } else {
        // Race both verification sources in parallel.
        const [wikiResult, osmResult] = await Promise.all([
          wikipediaSearchExists(name),
          openStreetMapSearchExists(name, destination),
        ]);
        exists = wikiResult || osmResult;
      }
      landmarkVerificationCache.set(cacheKey, exists);
      if (!exists) unverified.push(name);
    })
  );

  return unverified;
}

const GENERIC_ROUTE_WORDS = new Set([
  'morning', 'afternoon', 'evening', 'night', 'lunch', 'dinner', 'breakfast', 'snack',
  'arrive', 'arrival', 'depart', 'departure', 'check-in', 'check-out', 'check in', 'check out',
  'day', 'itinerary', 'trip', 'travel', 'flight', 'airport', 'hotel', 'accommodation',
  'city', 'country', 'neighborhood', 'district', 'area', 'downtown', 'metro', 'subway',
  'train', 'bus', 'taxi', 'walk', 'walking', 'stroll', 'explore', 'visit', 'see', 'do',
  'free', 'budget', 'affordable', 'cheap', 'quick', 'easy', 'short', 'long', 'tour', 'guide',
]);

const TRANSIT_ROUTE_WORDS = /\b(line|subway|metro|train|railway|station|airport|bus|taxi|walk|transfer|ic card|fare|ticket|pass|express|monorail|tram|ferry|metro line|subway line|bus route|train line)\b/i;

function isRouteCandidate(text: string): boolean {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 3) return false;
  if (cleaned.toLowerCase().startsWith('day ')) return false;
  if (GENERIC_ROUTE_WORDS.has(cleaned.toLowerCase())) return false;
  // Ignore time-slot section headings like "🌅 Morning:", "🌞 Afternoon:", "🌙 Evening:"
  // (with or without emoji prefix and trailing colon).
  if (/^(?:[🌅🌞🌙]\s*)?(?:morning|afternoon|evening|lunch|dinner|breakfast|snack|hotel|airport)\s*:?\s*$/iu.test(cleaned)) return false;
  // Ignore transit-mode names like "JR Yamanote Line", "Tokyo Metro", etc.
  if (TRANSIT_ROUTE_WORDS.test(cleaned)) return false;
  return true;
}

export function buildRouteLinks(itinerary: string, destination: string): RouteLink[] {
  if (!itinerary || !destination) return [];

  // Split by day headings at any level (##, ###, ####). Keep the delimiter with lookahead.
  const dayBlocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
  const links: RouteLink[] = [];

  for (const block of dayBlocks) {
    const headingMatch = block.match(/#+\s+Day\s+(\d+)(?:\s*[:\-]\s*(.*))?/i);
    if (!headingMatch) continue;

    const day = headingMatch[1];
    const title = (headingMatch[2] || '').trim();

    const candidates: string[] = [];

    // Image placeholders are explicit landmarks.
    for (const m of block.matchAll(/!\[IMAGE:\s*([^\]]+)\]/g)) {
      candidates.push(m[1].trim());
    }

    // Bold text is expected to be landmark/neighborhood names from the prompt.
    for (const m of block.matchAll(/\*\*(.*?)\*\*/g)) {
      const text = m[1].trim();
      if (isRouteCandidate(text)) candidates.push(text);
    }

    // Deduplicate while preserving order.
    const places: string[] = [];
    for (const name of candidates) {
      if (!places.includes(name)) places.push(name);
    }

    // Limit to 5 stops to keep Google Maps URLs short and useful.
    const stops = places.slice(0, 5);
    if (stops.length < 2) continue;

    const segments = stops.map((place) => encodeURIComponent(`${place}, ${destination}`)).join('/');
    // Build a highlight summary from the key stops (first 3).
    const highlights = stops.slice(0, 3).join(' → ');
    links.push({
      day,
      title,
      highlights,
      url: `https://www.google.com/maps/dir/${segments}`,
    });
  }

  return links;
}

