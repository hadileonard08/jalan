/**
 * Test: the unified collaboration timeline.
 *
 * Comments live inside the trip payload and proposals in their own table, so the
 * panel used to show two lists. This merges them into one ascending timeline.
 *
 * Usage:
 *   npx tsx scripts/test-trip-feed.ts
 */

import { buildTripFeed, proposalDays } from '../src/lib/trip-feed';
import type { DayFeedback, TripProposal } from '../src/lib/chat-state';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function comment(id: string, text: string, at: string) {
  return { id, author: 'You', text, createdAt: at };
}

function proposal(id: string, day: number, at: string, extra: Partial<TripProposal> = {}): TripProposal {
  return {
    id,
    tripId: 'trip',
    proposedByUserId: 'user_1',
    status: 'pending',
    suggestedPrompt: `prompt ${id}`,
    patchData: { edits: [{ dayNumber: day, action: 'add_stop' as const, newDetails: { name: 'X' } }] },
    createdAt: at,
    ...extra,
  } as TripProposal;
}

const dayFeedback: Record<string, DayFeedback> = {
  '1': {
    dayIndex: 1, thumbsUp: 0, thumbsDown: 0, userVote: null,
    comments: [comment('c1', 'first', '2026-09-14T10:00:00Z'), comment('c2', 'third', '2026-09-14T12:00:00Z')],
  },
  '2': {
    dayIndex: 2, thumbsUp: 0, thumbsDown: 0, userVote: null,
    comments: [comment('c3', 'day two', '2026-09-14T11:00:00Z')],
  },
};

console.log('═══════════════════════════════════════════════════════════');
console.log('  TEST: unified collaboration timeline');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('proposalDays:');
check('single-day patch', proposalDays(proposal('p1', 2, '2026-09-14T00:00:00Z')), [2]);
check('multi-day patch lists both', proposalDays({
  ...proposal('p2', 1, '2026-09-14T00:00:00Z'),
  patchData: { edits: [
    { dayNumber: 1, action: 'add_stop', newDetails: { name: 'A' } },
    { dayNumber: 3, action: 'add_stop', newDetails: { name: 'B' } },
  ] },
} as TripProposal), [1, 3]);
check('no edits -> no days', proposalDays({ ...proposal('p3', 1, 'x'), patchData: { edits: [] } } as TripProposal), []);

console.log('\nThe merge — comments and proposals interleaved by time:');
const proposals = [
  proposal('p1', 1, '2026-09-14T10:30:00Z', { summary: 'Swap the museum for the aquarium.' }),
  proposal('p2', 2, '2026-09-14T11:30:00Z'),
];
const feed = buildTripFeed({ dayFeedback, proposals });
check('ascending by createdAt', feed.map((i) => i.id), ['c1', 'p1', 'c3', 'p2', 'c2']);
check('types are carried', feed.map((i) => i.type), ['comment', 'proposal', 'comment', 'proposal', 'comment']);
check('comment content is its text', feed[0].content, 'first');
check('proposal content is the AI summary', feed[1].content, 'Swap the museum for the aquarium.');
check('falls back to the prompt when there is no summary', feed[3].content, 'prompt p2');
check('the record rides along for actions', !!feed[1].data.proposal && !!feed[0].data.comment, true);

console.log('\nPer-day slicing:');
check('day 1 only', buildTripFeed({ dayFeedback, proposals, day: 1 }).map((i) => i.id), ['c1', 'p1', 'c2']);
check('day 2 only', buildTripFeed({ dayFeedback, proposals, day: 2 }).map((i) => i.id), ['c3', 'p2']);
check('a day with nothing', buildTripFeed({ dayFeedback, proposals, day: 9 }), []);

console.log('\nOrder is stable when timestamps tie:');
const tied = buildTripFeed({
  dayFeedback: { '1': { dayIndex: 1, thumbsUp: 0, thumbsDown: 0, userVote: null, comments: [
    comment('bbb', 'b', '2026-09-14T10:00:00Z'),
    comment('aaa', 'a', '2026-09-14T10:00:00Z'),
  ] } },
  proposals: [],
});
check('ties fall back to id', tied.map((i) => i.id), ['aaa', 'bbb']);

console.log('\nEdge cases:');
check('no comments, no proposals', buildTripFeed({ proposals: [] }), []);
check('missing dayFeedback', buildTripFeed({ proposals: [proposal('p1', 1, '2026-09-14T10:00:00Z')] }).length, 1);
check('a proposal with no day is excluded from a day slice',
  buildTripFeed({ proposals: [{ ...proposal('p9', 1, 'x'), patchData: { edits: [] } } as TripProposal], day: 1 }).length, 0);
check('but included in the whole-trip feed',
  buildTripFeed({ proposals: [{ ...proposal('p9', 1, 'x'), patchData: { edits: [] } } as TripProposal] }).length, 1);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
console.log('═══════════════════════════════════════════════════════════\n');
if (failures > 0) process.exit(1);
