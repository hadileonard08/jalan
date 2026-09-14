import { verifyItineraryLandmarks, extractLandmarkNames } from './itinerary-guardrails';
import { findPossiblyClosedVenues } from '../lib/venue-status';
import { eveningFeasibilityWarnings } from '../lib/itinerary-feasibility';

// Deterministic itinerary checks, shared by the generation graph and by the
// suggestion preview. One implementation, so the two can't drift apart.

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function getExpectedTripDays(
  startDate: string | undefined,
  endDate: string | undefined,
  durationDays: number | undefined,
): number | undefined {
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
      return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    }
  }
  return durationDays && durationDays > 0 ? durationDays : undefined;
}

// Months a trip spans, as "YYYY-MM" keys.
function tripMonthKeys(startDate?: string, endDate?: string): Set<string> {
  const keys = new Set<string>();
  if (!startDate) return keys;
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return keys;
  const end = new Date(`${endDate || startDate}T00:00:00Z`);

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = Number.isNaN(end.getTime())
    ? cursor
    : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    keys.add(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

// Compares the dates printed in the itinerary's day headings against the dates the
// user actually asked for. Deterministic on purpose: an LLM judge estimating how
// far off a draft is gets the magnitude wrong (it once called a 4-month gap
// "1.5 years"), so the machine states the two ranges and nothing more.
export function findItineraryDateMismatch(
  itinerary: string,
  startDate?: string,
  endDate?: string,
): string | null {
  const allowed = tripMonthKeys(startDate, endDate);
  if (allowed.size === 0 || !itinerary) return null;

  // Only day headings — prose mentions ("the 2027 sakura season") are not dates.
  const headings = Array.from(itinerary.matchAll(/#{1,4}\s+Day\s+\d+[^\n]*/gi)).map((m) => m[0]);
  const offenders: string[] = [];

  const datePattern =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+(20\d{2}))?\b/gi;

  for (const heading of headings) {
    for (const match of heading.matchAll(datePattern)) {
      const monthKey = String(MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1).padStart(2, '0');
      const year = match[2];
      const ok = Array.from(allowed).some(
        (key) => key.endsWith(`-${monthKey}`) && (!year || key.startsWith(year)),
      );
      if (!ok) offenders.push(match[0].trim());
    }
  }

  if (offenders.length === 0) return null;
  const requested = endDate && endDate !== startDate ? `${startDate} to ${endDate}` : startDate;
  return `The itinerary's day headings are dated ${Array.from(new Set(offenders)).slice(0, 3).join(', ')}, but the user requested ${requested}. Regenerate every day for the requested dates.`;
}

export function findPastCalendarDates(text: string, referenceDate = new Date()): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) candidates.add(match[0]);
  for (const match of text.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/gi)) {
    candidates.add(match[0]);
  }

  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  return [...candidates].filter((candidate) => {
    const parsed = /^\d{4}-/.test(candidate)
      ? new Date(`${candidate}T00:00:00Z`)
      : new Date(candidate);
    return !Number.isNaN(parsed.getTime()) && parsed < today;
  });
}

function splitDayBlocks(itinerary: string): string[] {
  return itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
}

/**
 * Days that carry an image, in either form.
 *
 * Generated itineraries use `![IMAGE: landmark]` placeholders; saved ones have
 * been hydrated to `![landmark](url)`. Counting only placeholders made every
 * saved itinerary look image-less, which failed the guardrail on every refine
 * and silently downgraded the surgical patch to a full regeneration.
 */
export function countDaysWithImages(itinerary: string): number {
  return splitDayBlocks(itinerary).filter(
    (block) => /!\[IMAGE:/i.test(block) || /!\[[^\]]*\]\([^)]*\)/.test(block),
  ).length;
}

function daysMissingAllTimeBlocks(itinerary: string): string[] {
  const missing: string[] = [];
  for (const block of splitDayBlocks(itinerary)) {
    const headingMatch = block.match(/#+\s+Day\s+(\d+)/i);
    if (!headingMatch) continue;
    const hasAny = /morning/i.test(block) || /afternoon/i.test(block) || /evening/i.test(block);
    if (!hasAny) missing.push(`Day ${headingMatch[1]}`);
  }
  return missing;
}

export interface ItineraryCheckInput {
  itinerary: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  /**
   * Restrict landmark verification to this text. A suggestion only touches some
   * days, and re-verifying every landmark in a saved trip is both slow and noisy
   * (a pre-existing landmark on another day isn't this suggestion's problem).
   */
  landmarkScope?: string;
  /**
   * Also ask whether venues are still open (a Wikipedia request each). Off by
   * default: the generation path already makes two requests per landmark, and
   * being throttled would quietly weaken the existence check.
   */
  includeVenueStatus?: boolean;
}

export interface ItineraryCheckResult {
  /** Findings worth regenerating for — what the graph's Guardrails node feeds back. */
  feedback: string[];
  /** Worth telling a human, but never a reason to regenerate. */
  advisory: string[];
}

/**
 * Runs every deterministic check. The split matters: `feedback` is what the
 * graph acts on, `advisory` is only ever shown to a person, because a false
 * positive there would regenerate a good itinerary or push it to rejection.
 */
export async function runItineraryChecks({
  itinerary,
  destination,
  startDate,
  endDate,
  durationDays,
  landmarkScope,
  includeVenueStatus = false,
}: ItineraryCheckInput): Promise<ItineraryCheckResult> {
  const feedback: string[] = [];
  if (!itinerary) return { feedback, advisory: [] };

  // 1. Landmarks exist on Wikipedia.
  const unverified = await verifyItineraryLandmarks(landmarkScope || itinerary, destination);
  if (unverified.length > 0) {
    console.warn('[Guardrails] Unverified itinerary image landmarks:', unverified);
    feedback.push(`The following places or landmarks could not be verified and may be hallucinated or closed: ${unverified.join(', ')}. Replace them with real, well-known attractions or transit options that are clearly documented.`);
  }

  // 2. Day count matches the request, and every day has an image.
  const dayCount = (itinerary.match(/#{1,4}\s+Day\s+\d+/gi) || []).length;
  const expectedDays = getExpectedTripDays(startDate, endDate, durationDays);
  if (expectedDays && dayCount !== expectedDays) {
    feedback.push(`The user requested ${expectedDays} travel days, but the itinerary contains ${dayCount} day headings. Regenerate it with exactly ${expectedDays} days.`);
  }
  const imageDays = countDaysWithImages(itinerary);
  if (dayCount > 0 && imageDays < dayCount) {
    feedback.push(`The itinerary has ${dayCount} day(s) but only ${imageDays} image placeholder(s). Every day MUST have exactly one image placeholder in the format ![IMAGE: landmark name] immediately after the day heading. Add the missing placeholders.`);
  }

  // 3. No dates in the past.
  const pastDates = findPastCalendarDates(itinerary);
  if (pastDates.length > 0) {
    feedback.push(`The itinerary contains past calendar dates: ${pastDates.join(', ')}. Remove past events and regenerate the plan using only current or future travel dates and events.`);
  }

  // 4. The itinerary is for the dates the user asked for.
  const dateMismatch = findItineraryDateMismatch(itinerary, startDate, endDate);
  if (dateMismatch) feedback.push(dateMismatch);

  // 5. Each day has time blocks. Only flagged when a day has none — a single
  // missing slot is a formatting preference, not a safety issue.
  const noTimeBlocks = daysMissingAllTimeBlocks(itinerary);
  if (noTimeBlocks.length > 0) {
    feedback.push(`The following days have no time blocks at all: ${noTimeBlocks.join(', ')}. Reformat each day with three sub-sections using **🌅 Morning:**, **🌞 Afternoon:**, and **🌙 Evening:** headings.`);
  }

  // Advisory only: venues that close in the late afternoon sitting in the Evening.
  const advisory = eveningFeasibilityWarnings(itinerary);

  // Advisory only: venues whose Wikipedia article reads like they have closed.
  // Nothing else in the pipeline checks this — the guardrails only confirm a
  // venue exists, and the Critic has no opening-status context to judge.
  if (includeVenueStatus) {
    const closed = await findPossiblyClosedVenues(extractLandmarkNames(landmarkScope || itinerary));
    advisory.push(...closed.map((hint) => `${hint.name} — ${hint.reason}. Worth confirming before you go.`));
  }

  return { feedback, advisory };
}
