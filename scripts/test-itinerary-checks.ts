/**
 * Test: the shared deterministic itinerary checks.
 *
 * Regression for a bug this refactor uncovered: the image guard counted only
 * `![IMAGE:` placeholders, but a *saved* itinerary has been hydrated to
 * `![landmark](url)`. So every refine reported "0 image placeholders", failed the
 * guardrail, and silently downgraded the surgical patch to a full regeneration.
 *
 * Usage:
 *   npx tsx scripts/test-itinerary-checks.ts
 */

import { countDaysWithImages, getExpectedTripDays } from '../src/agents/itinerary-checks';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// Generated form: placeholders, pre-hydration.
const generated = `### Day 1: Arrival
![IMAGE: Space Needle]

**🌅 Morning:**
See the **Space Needle**.

### Day 2: Waterfront
![IMAGE: Pike Place Market]

**🌅 Morning:**
Walk **Pike Place Market**.
`;

// Saved form: the same itinerary after hydration.
const hydrated = `### Day 1: Arrival
![Space Needle](https://example.com/spaceneedle.jpg)

**🌅 Morning:**
See the **Space Needle**.

### Day 2: Waterfront
![Pike Place Market](https://example.com/pike.jpg)

**🌅 Morning:**
Walk **Pike Place Market**.
`;

console.log('═══════════════════════════════════════════════════════════');
console.log('  TEST: shared itinerary checks');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('countDaysWithImages — both forms must count:');
check('generated (placeholder form)', countDaysWithImages(generated), 2);
check('saved (hydrated form)', countDaysWithImages(hydrated), 2);
check('the regression: a saved itinerary is NOT image-less',
  countDaysWithImages(hydrated) < 2, false);

console.log('\nMissing images still count as missing:');
check('a day with no image at all', countDaysWithImages(`### Day 1
![IMAGE: A]

### Day 2
No image here.
`), 1);
check('no days -> 0', countDaysWithImages('Just prose.'), 0);

console.log('\ngetExpectedTripDays (moved here, unchanged):');
check('inclusive span', getExpectedTripDays('2026-10-01', '2026-10-05', undefined), 5);
check('single day', getExpectedTripDays('2026-10-01', '2026-10-01', undefined), 1);
check('falls back to duration', getExpectedTripDays(undefined, undefined, 7), 7);
check('nothing to go on', getExpectedTripDays(undefined, undefined, undefined), undefined);
check('end before start is ignored', getExpectedTripDays('2026-10-05', '2026-10-01', undefined), undefined);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
console.log('═══════════════════════════════════════════════════════════\n');
if (failures > 0) process.exit(1);
