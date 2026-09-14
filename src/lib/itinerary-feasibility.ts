// Time-slot feasibility: a venue that closes in the late afternoon shouldn't be
// the Evening stop.
//
// Deterministic, and advisory rather than blocking. OSM has no reliable hours
// feed here, so this is a name-based heuristic: it is deliberately conservative,
// because a false positive that fed back into the retry loop could regenerate a
// perfectly good itinerary (or push it to rejection).

// Venue types that reliably shut by late afternoon.
const CLOSES_EARLY =
  /\b(botanical|arboretum|conservatory|greenhouse|museums?|galleries|gallery|library|zoos?|aquariums?|mansion|palace)\b|\bgardens?\b/i;

// …except when the name says it is a night-time attraction, which is exactly the
// kind of false positive this guard exists to avoid ("Gardens by the Bay" hosts
// an evening light show).
const OPEN_LATE =
  /\b(by the bay|supertree|night|nuit|illuminat|lantern|light ?show|nightscape|evening)\b/i;

export interface EveningFeasibilityIssue {
  day: number;
  name: string;
}

function splitDayBlocks(itinerary: string): { day?: number; block: string }[] {
  return itinerary
    .split(/(?=#+\s+Day\s+\d+)/i)
    .filter((block) => block.length > 0)
    .map((block) => {
      const match = block.match(/#+\s+Day\s+(\d+)/i);
      return { day: match ? Number(match[1]) : undefined, block };
    });
}

// Everything from the Evening heading to the end of the day block.
function eveningSection(dayBlock: string): string {
  const idx = dayBlock.search(/\*\*[^*]*Evening[^*]*\*\*/i);
  return idx === -1 ? '' : dayBlock.slice(idx);
}

function boldNames(text: string): string[] {
  return Array.from(text.matchAll(/\*\*([^*]+)\*\*/g))
    .map((m) => m[1].trim())
    // Drop the time-block heading itself ("🌙 Evening:") and anything emoji-led.
    .filter((name) => name.length > 2 && !/evening|morning|afternoon/i.test(name))
    .filter((name) => !/^\p{Emoji}/u.test(name));
}

/**
 * Evening stops that look like venues closed by then.
 * Returns the day number and the venue name so the caller can say something
 * specific rather than a generic warning.
 */
export function findEveningClosedVenues(itinerary: string): EveningFeasibilityIssue[] {
  const issues: EveningFeasibilityIssue[] = [];
  for (const { day, block } of splitDayBlocks(itinerary)) {
    if (day === undefined) continue;
    for (const name of boldNames(eveningSection(block))) {
      if (CLOSES_EARLY.test(name) && !OPEN_LATE.test(name)) {
        issues.push({ day, name });
      }
    }
  }
  return issues;
}

/** One advisory line per issue, for the suggestion preview and the day panel. */
export function eveningFeasibilityWarnings(itinerary: string): string[] {
  return findEveningClosedVenues(itinerary).map(
    (issue) =>
      `${issue.name} (Day ${issue.day}) usually closes in the late afternoon, but it is in the Evening block.`,
  );
}
