// "Is this place still open?"
//
// Nothing in the pipeline answered that: the guardrails only confirmed a venue
// *exists* (Wikipedia/OSM), and neither says whether it closed. The Critic can't
// either — the retrieved context carries no opening status.
//
// There is no free, authoritative source for business status here (Google Places'
// `business_status` would be one, but needs a key). What Wikipedia does give is
// tense: a venue that has closed is written about in the past tense —
//
//   "From 2013 to 2024, it was operated by the Seattle International Film
//    Festival (SIFF)."                      ← SIFF Cinema Egyptian, closed 2025
//
// That is a hint, not a verdict, so every finding here is ADVISORY: it is shown
// to a person and never triggers a regeneration.

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const FETCH_TIMEOUT_MS = 5000;

// Phrases that only appear for a venue that has stopped operating.
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

// …unless the article also shows it operating now, which means the past-tense
// mention was about an earlier era rather than a closure.
//
// Kept deliberately narrow. A blunt `/\breopened\b/` guard suppressed the real
// closure below, because the article mentions the theatre reopening in *1980* and
// *2014* while also saying it closed indefinitely in 2024.
const STILL_OPEN_PATTERNS = [
  /\bas of \d{4}\b/i,
  /\bcurrently (?:open|operating|operates|hosts|runs|home to)\b/i,
  /\bis (?:currently )?(?:operated|run|owned|managed) by\b/i,
];

const introCache = new Map<string, string | null>();

const HEADERS = { 'User-Agent': 'flight-deal-dashboard/1.0 (venue status)' };

// Wikipedia throttles aggressively, and a 429 is not evidence of closure — so
// back off and retry, then give up quietly.
async function wikiJson(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1) * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      // A throttled or blocked response is plain text, not JSON.
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

  // Try the term as a title first — a redirect usually lands on the article,
  // which costs one request instead of two.
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

export interface VenueStatusHint {
  name: string;
  reason: string;
}

/**
 * Venues whose Wikipedia article reads like they have closed.
 * Names come from the itinerary's image alts, which is where stops are recorded.
 */
export async function findPossiblyClosedVenues(names: string[]): Promise<VenueStatusHint[]> {
  // Capped: each venue costs a Wikipedia request, and being throttled would
  // silently produce no findings at all.
  const unique = [...new Set(names.filter(Boolean))].slice(0, 20);
  const hints: VenueStatusHint[] = [];

  await Promise.all(
    unique.map(async (name) => {
      const intro = await wikipediaIntro(name);
      if (!intro) return;
      if (STILL_OPEN_PATTERNS.some((p) => p.test(intro))) return;

      // Patterns are ordered strongest-first, so quote the most telling one:
      // "closed indefinitely in November 2024" beats "was operated by".
      const hit = CLOSED_PATTERNS.find(({ pattern }) => pattern.test(intro));
      if (!hit) return;

      // Quote the sentence so the user can judge it rather than trust a label.
      const sentence = intro
        .split(/(?<=\.)\s+/)
        .find((s) => hit.pattern.test(s));
      hints.push({
        name,
        reason: `its Wikipedia article says it ${hit.label}${sentence ? `: "${sentence.trim().slice(0, 200)}"` : ''}`,
      });
    }),
  );

  return hints.sort((a, b) => a.name.localeCompare(b.name));
}

/** Clears the in-process cache. Test helper. */
export function clearVenueStatusCache() {
  introCache.clear();
}
