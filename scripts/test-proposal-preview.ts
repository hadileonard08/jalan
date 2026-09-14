/**
 * Test: the suggestion preview.
 *
 * Two things the preview must get right:
 *  - `wouldChange` — the warning a suggester sees before sending. A patch that
 *    matches nothing is rejected on accept (422), so catching it here saves the
 *    Master Planner a dead suggestion.
 *  - the patch a suggester confirms is validated when it comes back, since it
 *    arrives from the client rather than straight from the model.
 *
 * Usage:
 *   npx tsx scripts/test-proposal-preview.ts
 */

import { mergeItineraryPatch, meaningfulPatchOptions } from '../src/agents/refine-itinerary';
import { ItineraryPatchSchema, type ItineraryPatch } from '../src/lib/chat-state';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const itinerary = `# Seattle

## Day 1
**🌙 Evening:**
Visit the **Space Needle** for sunset.

## Day 2
**🌅 Morning:**
See the **Seattle Art Museum**.`;

// Mirrors what POST …/proposals/preview reports back.
const wouldChange = (patch: ItineraryPatch) => mergeItineraryPatch(itinerary, patch) !== itinerary;

const replaceStop: ItineraryPatch = {
  edits: [{
    dayNumber: 1,
    action: 'replace_stop',
    targetStopName: 'Space Needle',
    newDetails: { name: 'Bill Speidel’s Underground Tour' },
  }],
};
const noSuchStop: ItineraryPatch = {
  edits: [{
    dayNumber: 2,
    action: 'replace_stop',
    targetStopName: 'Great Wall of China',
    newDetails: { name: 'Something else' },
  }],
};

console.log('═══════════════════════════════════════════════════════════');
console.log('  TEST: suggestion preview');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('wouldChange (drives the "doesn\'t match anything" warning):');
check('a matching stop reports a change', wouldChange(replaceStop), true);
check('an unmatched stop reports no change', wouldChange(noSuchStop), false);
check('an empty patch reports no change', wouldChange({ edits: [] }), false);

console.log('\nDay targeting (the preview sends "Day N: <prompt>", the route uses dayIndex):');
const dayTwoEdit: ItineraryPatch = {
  edits: [{ dayNumber: 2, action: 'add_stop', newDetails: { name: 'Chihuly Garden', time_slot: 'evening' } }],
};
check('an edit on another day still applies', wouldChange(dayTwoEdit), true);
check('the untouched day is byte-for-byte identical',
  mergeItineraryPatch(itinerary, dayTwoEdit).split(/(?=^#+\s+Day\s+\d+)/im)[1],
  itinerary.split(/(?=^#+\s+Day\s+\d+)/im)[1]);

console.log('\nA confirmed patch is re-validated when it comes back:');
check('a valid patch is accepted', ItineraryPatchSchema.safeParse(replaceStop).success, true);
check('an empty edits array is valid', ItineraryPatchSchema.safeParse({ edits: [] }).success, true);
check('a missing dayNumber is rejected', ItineraryPatchSchema.safeParse({ edits: [{ action: 'add_stop' }] }).success, false);
check('an unknown action is rejected', ItineraryPatchSchema.safeParse({ edits: [{ dayNumber: 1, action: 'delete_everything' }] }).success, false);
check('day 0 is rejected', ItineraryPatchSchema.safeParse({ edits: [{ dayNumber: 0, action: 'add_stop' }] }).success, false);
check('a non-object is rejected', ItineraryPatchSchema.safeParse('nope').success, false);
check('null is rejected', ItineraryPatchSchema.safeParse(null).success, false);

console.log('\nOptions ("give me 2 options") — which ones the suggester sees:');
const option = (label: string, patch: ItineraryPatch) => ({ label, patch });
const twoOptions = [
  option('Swap for the aquarium', replaceStop),
  option('Swap for the ferry', dayTwoEdit),
];
check('several options all survive', meaningfulPatchOptions(twoOptions).length, 2);
check('labels are preserved', meaningfulPatchOptions(twoOptions).map((o) => o.label),
  ['Swap for the aquarium', 'Swap for the ferry']);
check('an option that edits nothing is dropped',
  meaningfulPatchOptions([...twoOptions, option('Do nothing', { edits: [] })]).length, 2);
check('an all-empty set falls back to one (so the "no match" warning still shows)',
  meaningfulPatchOptions([option('Do nothing', { edits: [] })]).length, 1);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
console.log('═══════════════════════════════════════════════════════════\n');
if (failures > 0) process.exit(1);
