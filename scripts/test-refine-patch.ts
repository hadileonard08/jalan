/**
 * Test: Delta Update (JSON Patch) pattern for the refine intent.
 *
 * This test verifies that mergeItineraryPatch() applies edits surgically:
 * - Day 2 lunch is swapped for a vegan spot.
 * - Days 1 and 3 are mathematically identical to the original.
 *
 * No Gemini tokens are consumed — this tests the deterministic merger only.
 *
 * Usage:
 *   npx tsx scripts/test-refine-patch.ts
 */

import { mergeItineraryPatch } from '../src/agents/refine-itinerary';
import type { ItineraryPatch } from '../src/lib/chat-state';

// ---------------------------------------------------------------------------
// Mock 3-day itinerary
// ---------------------------------------------------------------------------

const mockItinerary = `# Tokyo Itinerary — Oct 1 - Oct 3

## Day 1

**🌅 Morning:**
- **Senso-ji Temple** — Tokyo's oldest temple in Asakusa.
- **Nakamise Shopping Street** — Traditional snacks and souvenirs.

**🌞 Afternoon:**
- **Tokyo Skytree** — Panoramic views of the city.

![IMAGE: Senso-ji Temple]

**🌙 Evening:**
- **Shinjuku Golden Gai** — Tiny bars in a nostalgic alley.

## Day 2

**🌅 Morning:**
- **Meiji Shrine** — Serene forest shrine in Harajuku.

**🌞 Afternoon:**
- **Tsukiji Outer Market** — Fresh sushi and street food.

![IMAGE: Meiji Shrine]

**🌙 Evening:**
- **Shibuya Crossing** — The world's busiest pedestrian crossing.

## Day 3

**🌅 Morning:**
- **Ueno Park** — Museums and cherry blossoms.
- **Ameya-Yokocho Market** — Bargain shopping street.

**🌞 Afternoon:**
- **Akihabara Electric Town** — Anime, electronics, and gaming.

![IMAGE: Ueno Park]

**🌙 Evening:**
- **Tokyo Station Ramen Street** — Regional ramen under one roof.
`;

// ---------------------------------------------------------------------------
// Patch: "Swap the day 2 lunch for a vegan spot."
// ---------------------------------------------------------------------------

const patch: ItineraryPatch = {
  edits: [
    {
      dayNumber: 2,
      action: 'replace_stop',
      targetStopName: 'Tsukiji Outer Market',
      newDetails: {
        name: "T's Restaurant",
        description:
          'A popular vegan restaurant in Ginza offering plant-based Japanese cuisine.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Run the test
// ---------------------------------------------------------------------------

function runTest() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: Delta Update (JSON Patch) — mergeItineraryPatch');
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = mergeItineraryPatch(mockItinerary, patch);

  // --- Assertion 1: Day 1 is unchanged ---
  const originalDay1 = mockItinerary.split(/(?=##\s+Day\s+1)/i)[1].split(/(?=##\s+Day\s+2)/i)[0];
  const resultDay1 = result.split(/(?=##\s+Day\s+1)/i)[1].split(/(?=##\s+Day\s+2)/i)[0];
  const day1Unchanged = originalDay1 === resultDay1;
  console.log(`  Day 1 unchanged: ${day1Unchanged ? '✅ PASS' : '❌ FAIL'}`);
  if (!day1Unchanged) {
    console.log('  --- Expected Day 1 ---');
    console.log(originalDay1);
    console.log('  --- Got Day 1 ---');
    console.log(resultDay1);
  }

  // --- Assertion 2: Day 3 is unchanged ---
  const originalDay3 = mockItinerary.split(/(?=##\s+Day\s+3)/i)[1];
  const resultDay3 = result.split(/(?=##\s+Day\s+3)/i)[1];
  const day3Unchanged = originalDay3 === resultDay3;
  console.log(`  Day 3 unchanged: ${day3Unchanged ? '✅ PASS' : '❌ FAIL'}`);
  if (!day3Unchanged) {
    console.log('  --- Expected Day 3 ---');
    console.log(originalDay3);
    console.log('  --- Got Day 3 ---');
    console.log(resultDay3);
  }

  // --- Assertion 3: Day 2 has the new vegan stop ---
  const resultDay2 = result.split(/(?=##\s+Day\s+2)/i)[1].split(/(?=##\s+Day\s+3)/i)[0];
  const hasVegan = /T's Restaurant/i.test(resultDay2);
  const hasOldLunch = /Tsukiji Outer Market/i.test(resultDay2);
  console.log(`  Day 2 has new vegan stop: ${hasVegan ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Day 2 old lunch removed: ${!hasOldLunch ? '✅ PASS' : '❌ FAIL'}`);

  // --- Assertion 4: Day 2 morning and evening are unchanged ---
  const originalDay2 = mockItinerary.split(/(?=##\s+Day\s+2)/i)[1].split(/(?=##\s+Day\s+3)/i)[0];
  const origMorning = originalDay2.split(/(?=\*\*🌅)/i)[1].split(/(?=\*\*🌞)/i)[0];
  const resultMorning = resultDay2.split(/(?=\*\*🌅)/i)[1].split(/(?=\*\*🌞)/i)[0];
  const morningUnchanged = origMorning === resultMorning;
  console.log(`  Day 2 morning unchanged: ${morningUnchanged ? '✅ PASS' : '❌ FAIL'}`);

  const origEvening = originalDay2.split(/(?=\*\*🌙)/i)[1];
  const resultEvening = resultDay2.split(/(?=\*\*🌙)/i)[1];
  const eveningUnchanged = origEvening === resultEvening;
  console.log(`  Day 2 evening unchanged: ${eveningUnchanged ? '✅ PASS' : '❌ FAIL'}`);

  // --- Summary ---
  const allPassed = day1Unchanged && day3Unchanged && hasVegan && !hasOldLunch && morningUnchanged && eveningUnchanged;
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!allPassed) {
    console.log('--- Full result ---');
    console.log(result);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Regression: stops that share a prose line with other bold stops.
//
// Real itinerary text packs several bold stops into one sentence:
//   "visit the iconic **Space Needle**. ... dinner at **The Pink Door** nearby."
// Only checking the first bold span on a line silently dropped the edit while
// the proposal was still marked accepted.
// ---------------------------------------------------------------------------

const proseItinerary = `# Seattle Itinerary — Sep 30

## Day 1: Welcome to the Emerald City

**🌞 Afternoon:**
Walk over to the historic **Pike Place Market**. Grab lunch at **Pike Place Chowder**.

**🌙 Evening:**
Head up to the **Lower Queen Anne** neighborhood to visit the iconic **Space Needle**. Going up to the observation deck just before sunset gives you a breathtaking 360-degree view of the city transitioning from day to night. Afterward, enjoy a delicious, cozy dinner at **The Pink Door** nearby.
`;

const prosePatch: ItineraryPatch = {
  edits: [
    {
      dayNumber: 1,
      action: 'replace_stop',
      targetStopName: 'Space Needle',
      newDetails: {
        name: "Bill Speidel's Underground Tour",
        description: 'Explore historic Pioneer Square underground, entirely on foot.',
      },
    },
  ],
};

function runProseTest() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: replace_stop inside a multi-stop prose line');
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = mergeItineraryPatch(proseItinerary, prosePatch);

  const changed = result !== proseItinerary;
  console.log(`  Itinerary changed: ${changed ? '✅ PASS' : '❌ FAIL (silent no-op)'}`);

  const hasNew = result.includes("Bill Speidel's Underground Tour");
  console.log(`  New stop inserted: ${hasNew ? '✅ PASS' : '❌ FAIL'}`);

  const oldGone = !result.includes('**Space Needle**');
  console.log(`  Old stop removed: ${oldGone ? '✅ PASS' : '❌ FAIL'}`);

  const staleGone = !result.includes('Going up to the observation deck');
  console.log(`  Stale description dropped: ${staleGone ? '✅ PASS' : '❌ FAIL'}`);

  // Neighbouring stops on the same line must survive.
  const neighboursKept = ['Pike Place Market', 'Pike Place Chowder', 'The Pink Door'].every((stop) =>
    result.includes(stop)
  );
  console.log(`  Neighbour stops kept: ${neighboursKept ? '✅ PASS' : '❌ FAIL'}`);

  const allPassed = changed && hasNew && oldGone && staleGone && neighboursKept;
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!allPassed) {
    console.log('--- Full result ---');
    console.log(result);
    process.exit(1);
  }
}

runTest();
runProseTest();
