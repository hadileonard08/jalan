/**
 * Test: enrichment refresh after an approved itinerary edit.
 *
 * An accepted patch rewrites the itinerary text, which leaves the day's hero
 * image, route link, map waypoints, and transport notes describing the OLD stop.
 * These are the pure helpers behind the refresh.
 *
 * No network and no LLM calls.
 *
 * Usage:
 *   npx tsx scripts/test-refresh-enrichment.ts
 */

import {
  affectedDaysFromPatch,
  stripTransportNotes,
  findStaleImage,
  primaryLandmark,
  staleImageDays,
} from '../src/lib/refresh-enrichment';
import type { ItineraryPatch } from '../src/lib/chat-state';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// Mirrors the real Day 1 that broke: the text was patched, the image was not.
const patchedDay = `### Day 1: Wednesday, September 30 - Welcome to the Emerald City
![Space Needle](https://example.com/spaceneedle.jpg)

**🌅 Morning:**
After landing at **Seattle-Tacoma International Airport** at noon, hop onto the Link Light Rail.

**🌙 Evening:**
Visit **Bill Speidel's Underground Tour** — a guided walk under Pioneer Square. Dinner at **The Pink Door** nearby.

**🚶 Getting around (real times via routing):**
- **🚶 Walk** · ~12 min walk — Space Needle → Pike Place Market
`;

function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: enrichment refresh after an approved edit');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('affectedDaysFromPatch:');
  const replace: ItineraryPatch = {
    edits: [{ dayNumber: 1, action: 'replace_stop', targetStopName: 'Space Needle', newDetails: { name: "Bill Speidel's Underground Tour" } }],
  };
  check('replace_stop carries the new landmark as a hint', affectedDaysFromPatch(replace), [
    { dayNumber: 1, landmarkHint: "Bill Speidel's Underground Tour" },
  ]);
  check('remove_stop has no hint', affectedDaysFromPatch({
    edits: [{ dayNumber: 2, action: 'remove_stop', targetStopName: 'Brewery' }],
  }), [{ dayNumber: 2, landmarkHint: undefined }]);
  check('multiple edits on one day collapse', affectedDaysFromPatch({
    edits: [
      { dayNumber: 3, action: 'add_stop', newDetails: { name: 'Museum' } },
      { dayNumber: 3, action: 'update_note', targetStopName: 'Cafe' },
    ],
  }), [{ dayNumber: 3, landmarkHint: 'Museum' }]);
  check('invalid day numbers are skipped', affectedDaysFromPatch({
    edits: [{ dayNumber: 0, action: 'add_stop', newDetails: { name: 'X' } }],
  }), []);
  check('empty patch touches nothing', affectedDaysFromPatch({ edits: [] }), []);

  console.log('\nstripTransportNotes (must not duplicate on re-inject):');
  const stripped = stripTransportNotes(patchedDay);
  check('removes the old note', stripped.includes('Getting around (real times'), false);
  check('keeps the day content', stripped.includes('Bill Speidel'), true);
  check('keeps the image', stripped.includes('spaceneedle.jpg'), true);
  check('idempotent', stripTransportNotes(stripped) === stripped, true);
  check('no-op when there is no note', stripTransportNotes('### Day 9: nothing here') === '### Day 9: nothing here', true);

  console.log('\nfindStaleImage:');
  const stale = findStaleImage(stripTransportNotes(patchedDay));
  check('detects the Space Needle image as stale', stale?.alt, 'Space Needle');
  check('reports the old url', stale?.url, 'https://example.com/spaceneedle.jpg');
  const matching = `### Day 1: Arrival
![Bill Speidel's Underground Tour](https://example.com/under.jpg)

Visit **Bill Speidel's Underground Tour** today.`;
  check('a matching image is NOT stale', findStaleImage(matching), null);
  check('no image -> null', findStaleImage('### Day 1: Arrival\nNo image here.'), null);

  console.log('\nprimaryLandmark:');
  // Skips the "🌅 Morning:" heading AND the airport — transit-ish names make poor
  // hero images, so the first real landmark wins.
  check('skips time-slot headings and transit names',
    primaryLandmark(stripTransportNotes(patchedDay)), "Bill Speidel's Underground Tour");
  check('skips transit-ish bold text', primaryLandmark(`### Day 2
**🌅 Morning:**
Take the **JR Yamanote Line** to **Ueno Park**.`), 'Ueno Park');
  check('null when there is nothing bold', primaryLandmark('### Day 3\nplain text'), null);

  console.log('\nstaleImageDays (what the backfill targets):');
  check('flags Day 1 of the broken trip', staleImageDays(patchedDay), [1]);
  check('clean trip -> nothing to fix', staleImageDays(matching), []);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

run();
