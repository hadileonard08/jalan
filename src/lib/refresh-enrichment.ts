import { buildTransportPlan, injectTransportNotes, type TransportPlan } from '../agents/transport';
import { buildRouteLinks } from '../agents/itinerary-guardrails';
import { getImageForTerm } from '../agents/destination-images';
import type { ChatPayload, ItineraryPatch, RouteLink } from './chat-state';

// Refreshes the parts of a saved trip that describe *stops* after an approved
// itinerary edit: the day's hero image, its route links, its transport plan, and
// the transport notes inside the day's text.
//
// Deliberately targeted rather than a full re-enrichment, because both of the
// obvious re-runs are unsafe on an already-hydrated itinerary:
//   - hydrateItineraryImages() re-inserts a placeholder for any day without an
//     `![IMAGE:` marker — which is every hydrated day, so it would add a second
//     image per day.
//   - injectTransportNotes() appends, so it would duplicate the notes.

const TRANSPORT_NOTE_MARKER = '**🚶 Getting around (real times via routing):**';
const IMAGE_PATTERN = /!\[([^\]]+)\]\(([^)]+)\)/;

// Words that look like bold text but are not landmarks.
const GENERIC_BOLD = new Set([
  'morning', 'afternoon', 'evening', 'night', 'lunch', 'dinner', 'breakfast',
  'getting around', 'transport', 'tips', 'overview', 'summary',
]);
const TRANSIT_BOLD = /\b(line|subway|metro|train|railway|station|airport|bus|taxi|walk|transfer|fare|ticket|pass|express|monorail|tram|ferry)\b/i;

// Days a patch touches, with the replacement name when the edit supplies one.
export function affectedDaysFromPatch(
  patch: ItineraryPatch,
): { dayNumber: number; landmarkHint?: string }[] {
  const days = new Map<number, string | undefined>();
  for (const edit of patch.edits || []) {
    const day = edit.dayNumber;
    if (!Number.isInteger(day) || day < 1) continue;
    const hint = edit.newDetails?.name;
    if (hint) days.set(day, hint);
    else if (!days.has(day)) days.set(day, undefined);
  }
  return Array.from(days, ([dayNumber, landmarkHint]) => ({ dayNumber, landmarkHint }));
}

// Removes a previously injected transport note from a day block, so a refresh
// can append a fresh one without duplicating.
export function stripTransportNotes(dayBlock: string): string {
  const idx = dayBlock.indexOf(TRANSPORT_NOTE_MARKER);
  if (idx === -1) return dayBlock;
  return `${dayBlock.slice(0, idx).trimEnd()}\n`;
}

// The day's hero image is stale when its caption no longer appears in the day —
// exactly what happens after `replace_stop` renames a stop but leaves the
// already-hydrated `![Old Landmark](url)` in place.
export function findStaleImage(dayBlock: string): { alt: string; url: string } | null {
  const match = dayBlock.match(IMAGE_PATTERN);
  if (!match) return null;
  const alt = match[1].trim();
  if (!alt) return null;
  const withoutImage = dayBlock.replace(match[0], '');
  return withoutImage.toLowerCase().includes(alt.toLowerCase()) ? null : { alt, url: match[2] };
}

// First bolded stop in a day that is plausibly a landmark.
export function primaryLandmark(dayBlock: string): string | null {
  const heading = dayBlock.match(/#+\s+Day\s+\d+[^\n]*/i);
  const body = heading
    ? dayBlock.slice(dayBlock.indexOf(heading[0]) + heading[0].length)
    : dayBlock;
  for (const match of body.matchAll(/\*\*([^*]+)\*\*/g)) {
    const name = match[1].trim();
    if (name.length < 3) continue;
    if (GENERIC_BOLD.has(name.toLowerCase())) continue;
    if (TRANSIT_BOLD.test(name)) continue;
    if (/^[\p{Emoji}\s]/u.test(name) && /morning|afternoon|evening/i.test(name)) continue;
    return name;
  }
  return null;
}

function splitDays(itinerary: string): { day?: number; block: string }[] {
  return itinerary
    .split(/(?=#+\s+Day\s+\d+)/i)
    .filter((block) => block.length > 0)
    .map((block) => {
      const match = block.match(/#+\s+Day\s+(\d+)/i);
      return { day: match ? Number(match[1]) : undefined, block };
    });
}

// Days whose hero image no longer matches their content — used by the backfill
// for trips edited before the refresh existed.
//
// This is the reliable "was this day edited?" signal: the caption has to name a
// stop that still exists in the day. A transport-based check was tried and
// dropped — a stale transport note contains the old stop names itself, so it
// both masks real staleness and flags days that were never edited.
export function staleImageDays(itinerary: string): number[] {
  return splitDays(itinerary)
    .filter(({ day, block }) => day !== undefined && findStaleImage(stripTransportNotes(block)) !== null)
    .map(({ day }) => day as number);
}

export async function refreshEnrichment(
  payload: ChatPayload,
  destination: string,
  days: { dayNumber: number; landmarkHint?: string }[],
): Promise<ChatPayload> {
  const itinerary = payload.itinerary || '';
  if (!itinerary || days.length === 0) return payload;

  const affected = new Set(days.map((d) => d.dayNumber));
  const hintByDay = new Map(days.map((d) => [d.dayNumber, d.landmarkHint]));

  // --- 1. Per-day image refresh ------------------------------------------
  const blocks = splitDays(itinerary);
  const refreshedBlocks = await Promise.all(
    blocks.map(async ({ day, block }) => {
      if (day === undefined || !affected.has(day)) return block;

      const stripped = stripTransportNotes(block);
      const stale = findStaleImage(stripped);
      if (!stale) return stripped;

      const term = hintByDay.get(day) || primaryLandmark(stripped);
      if (!term) return stripped;

      const url = await getImageForTerm(term, destination ? [`${destination} ${term}`] : []);
      if (!url) return stripped;

      console.log(`[Refresh] Day ${day}: image "${stale.alt}" -> "${term}"`);
      return stripped.replace(stale.url, url).replace(
        IMAGE_PATTERN,
        `![${term}](${url})`,
      );
    }),
  );
  let nextItinerary = refreshedBlocks.join('');

  // --- 2. Route links for the affected days -------------------------------
  // Rebuilding all links is pure string work; only the changed days are kept.
  const rebuiltLinks = buildRouteLinks(nextItinerary, destination);
  const routeLinks: RouteLink[] = (payload.routeLinks || []).map((link) => {
    const fresh = rebuiltLinks.find((l) => l.day === link.day);
    return fresh && affected.has(Number(link.day)) ? fresh : link;
  });
  for (const fresh of rebuiltLinks) {
    if (affected.has(Number(fresh.day)) && !routeLinks.some((l) => l.day === fresh.day)) {
      routeLinks.push(fresh);
    }
  }

  // --- 3. Transport plan for the affected days ----------------------------
  let transportPlan = payload.transportPlan || null;
  try {
    const affectedLinks = routeLinks.filter((l) => affected.has(Number(l.day)));
    // Skip the city-tips LLM call — one stop changing does not change the city.
    const rebuilt = await buildTransportPlan(affectedLinks, destination, nextItinerary, {
      skipCityTips: true,
    });
    if (rebuilt?.days?.length) {
      // Keep the existing city tips — they don't change because one stop did.
      const mergedDays = (transportPlan?.days || []).map(
        (d) => rebuilt.days.find((r) => r.day === d.day) || d,
      );
      for (const day of rebuilt.days) {
        if (!mergedDays.some((d) => d.day === day.day)) mergedDays.push(day);
      }
      const plan: TransportPlan = {
        cityTransitTips: transportPlan?.cityTransitTips || rebuilt.cityTransitTips,
        estimatedCosts: transportPlan?.estimatedCosts || rebuilt.estimatedCosts,
        days: mergedDays.sort((a, b) => Number(a.day) - Number(b.day)),
      };
      transportPlan = plan;

      // Mirror enrichNode: prefer the optimizer's URL on the route link.
      for (const day of plan.days) {
        const link = routeLinks.find((l) => l.day === day.day);
        if (link && day.optimizedUrl) link.url = day.optimizedUrl;
      }

      // Re-append transport notes for the affected days only.
      nextItinerary = injectTransportNotes(nextItinerary, {
        ...plan,
        days: plan.days.filter((d) => affected.has(Number(d.day))),
      });
    }
  } catch (error) {
    console.warn('[Refresh] transport refresh failed, keeping the old plan:', error);
  }

  return { ...payload, itinerary: nextItinerary, routeLinks, transportPlan: transportPlan || undefined };
}
