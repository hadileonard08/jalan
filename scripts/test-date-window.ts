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

import {
  resolveSeasonalStartDate,
  hasStatedDateWindow,
  findItineraryDateMismatch,
} from '../src/agents/conversation-graph';

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

  console.log('\nfindItineraryDateMismatch (deterministic, so the numbers are right):');
  const marchDraft = '### Day 1: Wednesday, March 20 - Arrival\n### Day 2: Thursday, March 21';
  const novemberDraft = '### Day 1: Thursday, November 12 - Arrival\n### Day 2: Friday, November 13';

  check('matching draft -> no finding', findItineraryDateMismatch(marchDraft, '2027-03-20', '2027-03-24'), null);
  const flagged = findItineraryDateMismatch(novemberDraft, '2027-03-20', '2027-03-24');
  check('wrong-season draft IS flagged', typeof flagged === 'string', true);
  check('finding quotes the requested range', !!flagged && flagged.includes('2027-03-20 to 2027-03-24'), true);
  check('finding quotes what the draft actually says', !!flagged && flagged.includes('November 12'), true);
  // The whole point: no invented magnitude anywhere in the message.
  check('finding makes no magnitude claim', !!flagged && !/\d+(\.\d+)?\s*(years?|months?)/i.test(flagged), true);

  check('a trip spanning two months accepts both',
    findItineraryDateMismatch('### Day 1: Sunday, September 30\n### Day 7: Saturday, October 6', '2026-09-30', '2026-10-06'), null);
  check('month-only heading matches any year in range',
    findItineraryDateMismatch('### Day 1: Monday, March 20', '2027-03-20', '2027-03-24'), null);
  check('explicit wrong year is caught',
    typeof findItineraryDateMismatch('### Day 1: Saturday, March 20, 2026', '2027-03-20', '2027-03-24'), 'string');
  check('prose dates are ignored (headings only)',
    findItineraryDateMismatch('Visit during the November 2026 festival.\n### Day 1: Arrival', '2027-03-20', '2027-03-24'), null);
  check('undated headings -> no finding',
    findItineraryDateMismatch('### Day 1: Welcome to Paradise\n### Day 2: Beaches', '2027-03-20', '2027-03-24'), null);
  check('no requested dates -> no finding', findItineraryDateMismatch(novemberDraft, undefined, undefined), null);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

run();
