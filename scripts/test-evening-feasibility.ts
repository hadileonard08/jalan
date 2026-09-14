/**
 * Test: evening time-slot feasibility.
 *
 * Regression for "the AI put Seattle Japanese Garden in the Evening, but it
 * closes at 6pm". Also run against the real saved itineraries to check the
 * heuristic doesn't cry wolf — a false positive here would nag about good plans.
 *
 * Usage:
 *   npx tsx scripts/test-evening-feasibility.ts
 */

import { findEveningClosedVenues, eveningFeasibilityWarning } from '../src/lib/itinerary-feasibility';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function day(n: number, evening: string) {
  return `### Day ${n}: Something\n\n**🌅 Morning:**\nSee the **Central Market**.\n\n**🌙 Evening:**\n${evening}\n`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: evening time-slot feasibility');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('The reported case:');
  const reported = day(2, 'Visit the **Seattle Japanese Garden** — stroll the arboretum trails.');
  check('flags the Japanese Garden in the Evening',
    findEveningClosedVenues(reported), [{ day: 2, name: 'Seattle Japanese Garden' }]);
  check('and the warning names it',
    eveningFeasibilityWarning(reported)?.includes('Seattle Japanese Garden'), true);
  check('the warning names the day', eveningFeasibilityWarning(reported)?.includes('Day 2'), true);

  console.log('\nAlso caught:');
  check('a museum', findEveningClosedVenues(day(1, 'Visit the **City Art Museum**.')).length, 1);
  check('an aquarium', findEveningClosedVenues(day(1, 'See the **Bay Aquarium**.')).length, 1);
  check('a library', findEveningClosedVenues(day(1, 'Browse the **Central Library**.')).length, 1);
  check('a botanical garden', findEveningClosedVenues(day(1, 'Wander the **Royal Botanical Gardens**.')).length, 1);

  console.log('\nNOT caught (avoiding false positives):');
  check('a dinner restaurant', findEveningClosedVenues(day(1, 'Dinner at **The Pink Door** nearby.')), []);
  check('a night market', findEveningClosedVenues(day(1, 'Explore the **Night Market** for street food.')), []);
  check('an observatory', findEveningClosedVenues(day(1, 'Sunset from the **Skyline Observatory**.')), []);
  check('a district walk', findEveningClosedVenues(day(1, 'Evening stroll through **Old Town**.')), []);
  check('a rooftop bar', findEveningClosedVenues(day(1, 'Drinks at a **Rooftop Bar** downtown.')), []);
  check('a temple night visit', findEveningClosedVenues(day(1, 'See the **Golden Temple** lit up.')), []);
  check('Gardens by the Bay (evening light show)', findEveningClosedVenues(day(1, 'Watch the light show at **Gardens by the Bay**.')), []);

  console.log('\nA garden in the Morning or Afternoon is fine:');
  check('morning garden', findEveningClosedVenues(
    '### Day 1\n\n**🌅 Morning:**\nVisit the **Seattle Japanese Garden**.\n\n**🌙 Evening:**\nDinner at **The Pink Door**.\n'), []);
  check('afternoon museum', findEveningClosedVenues(
    '### Day 1\n\n**🌞 Afternoon:**\nThe **City Museum**.\n\n**🌙 Evening:**\nDinner at **Cafe Rio**.\n'), []);

  console.log('\nNo Evening block at all:');
  check('nothing to check', findEveningClosedVenues('### Day 1\n\n**🌅 Morning:**\nThe **City Museum**.\n'), []);
  check('empty itinerary', findEveningClosedVenues(''), []);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
