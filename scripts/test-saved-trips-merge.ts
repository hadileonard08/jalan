/**
 * Test: reconciling the local trip list with the server's.
 *
 * Regression for "I accepted an invitation but the trip isn't in One Stop": the
 * refresh only mapped over trips already in state, so a trip shared with you
 * while the app was open never appeared until a full page reload.
 *
 * Usage:
 *   npx tsx scripts/test-saved-trips-merge.ts
 */

import { mergeServerTrips } from '../src/lib/saved-trips-merge';
import type { SavedTrip } from '../src/lib/chat-state';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function trip(id: string, overrides: Partial<SavedTrip> = {}): SavedTrip {
  return {
    id,
    conversationId: '',
    destination: id,
    dates: '2027-01-01',
    payload: { itinerary: `### ${id}` },
    todos: [],
    notes: '',
    noteEntries: [],
    feedback: {},
    dayFeedback: {},
    flightInfo: [],
    documents: [],
    savedAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  } as SavedTrip;
}

function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: saved-trip list reconciliation');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('The reported bug — a trip shared while the app was open:');
  const before = [trip('mine')];
  const afterServer = [trip('mine'), trip('shared-seattle')];
  const added = mergeServerTrips(before, afterServer);
  check('the newly shared trip appears', added.map((t) => t.id), ['mine', 'shared-seattle']);
  check('its itinerary comes with it', added[1].payload.itinerary, '### shared-seattle');

  console.log('\nThe first-load case (nothing local yet):');
  check('a follower with only a shared trip sees it',
    mergeServerTrips([], [trip('shared-seattle')]).map((t) => t.id), ['shared-seattle']);

  console.log('\nUnsynced local edits survive the merge:');
  const local = [trip('mine', { notes: 'my draft note', todos: [{ id: 't1', text: 'book ferry', done: false }] })];
  const server = [trip('mine', { payload: { itinerary: '### updated by a collaborator' } })];
  const merged = mergeServerTrips(local, server);
  check('local notes kept', merged[0].notes, 'my draft note');
  check('local todos kept', merged[0].todos, [{ id: 't1', text: 'book ferry', done: false }]);
  check('server payload wins', merged[0].payload.itinerary, '### updated by a collaborator');

  console.log('\nThe server owns membership and order:');
  check('a trip deleted on the server disappears',
    mergeServerTrips([trip('mine'), trip('gone')], [trip('mine')]).map((t) => t.id), ['mine']);
  check('order follows the server',
    mergeServerTrips([trip('a'), trip('b')], [trip('b'), trip('a')]).map((t) => t.id), ['b', 'a']);

  console.log('\nWeather fields come from the server:');
  const withWeather = mergeServerTrips(
    [trip('mine')],
    [trip('mine', { weatherAlert: 'Rain expected', weatherSnapshot: { updatedAt: 'x', timezone: null, days: [] } })],
  );
  check('weather alert merged', withWeather[0].weatherAlert, 'Rain expected');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

run();
