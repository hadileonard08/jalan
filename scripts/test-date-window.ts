/**
 * Test: date-window handling in Extract.
 *
 * Regression for the bug where "spring 2027 to tokyo" was silently planned as
 * 2026-11-12 (today + 60 days) — wrong season, wrong year — and then rejected by
 * the Critic for not matching the request.
 *
 * No LLM calls: exercises the pure date helpers.
 *
 * Usage:
 *   npx tsx scripts/test-date-window.ts
 */

import { resolveSeasonalStartDate, hasStatedDateWindow } from '../src/agents/conversation-graph';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// Fixed "today" so the expectations don't drift.
const today = new Date('2026-09-13T00:00:00Z');

function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: seasonal + flexible date windows');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('resolveSeasonalStartDate (the reported bug):');
  check('"spring 2027" -> March 2027', resolveSeasonalStartDate('spring 2027', today), '2027-03-20');
  check('"Spring 2027" is case-insensitive', resolveSeasonalStartDate('Spring 2027', today), '2027-03-20');
  check('"summer 2028"', resolveSeasonalStartDate('summer 2028', today), '2028-06-21');
  check('"autumn 2027"', resolveSeasonalStartDate('autumn 2027', today), '2027-09-22');
  check('"fall 2027" (US spelling)', resolveSeasonalStartDate('fall 2027', today), '2027-09-22');
  check('"winter 2028"', resolveSeasonalStartDate('winter 2028', today), '2028-12-21');
  check('bare "spring" -> next occurrence', resolveSeasonalStartDate('spring', today), '2027-03-20');
  check('bare "autumn" -> still ahead this year', resolveSeasonalStartDate('autumn', today), '2026-09-22');
  check('bare "winter" -> still ahead this year', resolveSeasonalStartDate('winter', today), '2026-12-21');
  check('no season -> null', resolveSeasonalStartDate('2 weeks in Japan', today), null);
  check('empty -> null', resolveSeasonalStartDate('', today), null);
  check('undefined -> null', resolveSeasonalStartDate(undefined, today), null);

  console.log('\nhasStatedDateWindow (when is inventing a date allowed?):');
  check('"spring 2027" is a stated window', hasStatedDateWindow('spring 2027'), true);
  check('"October" is a stated window', hasStatedDateWindow('October'), true);
  check('"next June" is a stated window', hasStatedDateWindow('next June'), true);
  check('"flexible" is NOT a window', hasStatedDateWindow('flexible'), false);
  check('"whenever" is NOT a window', hasStatedDateWindow('whenever'), false);
  check('"no preference" is NOT a window', hasStatedDateWindow('no preference'), false);
  check('"" is NOT a window', hasStatedDateWindow(''), false);
  check('undefined is NOT a window', hasStatedDateWindow(undefined), false);

  console.log('\nThe reported scenario, end to end (logic only):');
  const datesGeneral = 'spring 2027';
  const resolved = resolveSeasonalStartDate(datesGeneral, today);
  const wouldInvent = !resolved && !hasStatedDateWindow(datesGeneral);
  check('startDate resolves to spring 2027', resolved, '2027-03-20');
  check('the today+60d fallback does NOT fire', wouldInvent, false);
  check('it is not November 2026', resolved !== '2026-11-12', true);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

run();
