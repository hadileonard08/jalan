/**
 * Test: concurrency guards on the proposal review path.
 *
 * Two reviewers can act at the same moment. Without these guards both requests
 * pass a `status === 'pending'` check and both write the payload — the same
 * suggestion is applied twice and one reviewer's change is silently lost.
 *
 * Runs against the real database with genuinely parallel calls.
 *
 * Usage:
 *   npx tsx scripts/test-review-concurrency.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { savedTrips, tripProposals } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { claimProposal, releaseProposal, commitPayload } from '../src/lib/proposal-review';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const TEST_USER = '__test_concurrency__';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: proposal review concurrency guards');
  console.log('═══════════════════════════════════════════════════════════\n');

  const [trip] = await db
    .insert(savedTrips)
    .values({
      userId: TEST_USER,
      destination: '__concurrency_test__',
      dates: '2027-01-01 - 2027-01-05',
      payload: JSON.stringify({ itinerary: '### Day 1\noriginal' }),
    })
    .returning();

  const [proposal] = await db
    .insert(tripProposals)
    .values({
      tripId: trip.id,
      proposedByUserId: TEST_USER,
      suggestedPrompt: 'test',
      patchData: { edits: [{ dayNumber: 1, action: 'add_stop', newDetails: { name: 'X' } }] },
    })
    .returning();

  console.log('Two reviewers accept the same suggestion at once:');
  const claims = await Promise.all([
    claimProposal(trip.id, proposal.id, 'accepted'),
    claimProposal(trip.id, proposal.id, 'accepted'),
  ]);
  const winners = claims.filter(Boolean).length;
  check('exactly one claim wins', winners, 1);
  check('the loser gets null', claims.filter((c) => c === null).length, 1);

  const afterClaim = await db.select().from(tripProposals).where(eq(tripProposals.id, proposal.id)).limit(1);
  check('the suggestion ends up accepted exactly once', afterClaim[0].status, 'accepted');

  console.log('\nA second reviewer retries the same suggestion:');
  const retry = await claimProposal(trip.id, proposal.id, 'accepted');
  check('a reviewed suggestion cannot be claimed again', retry, null);

  console.log('\nreleaseProposal (used when the itinerary write loses a race):');
  await releaseProposal(proposal.id);
  const released = await db.select().from(tripProposals).where(eq(tripProposals.id, proposal.id)).limit(1);
  check('goes back to pending', released[0].status, 'pending');
  check('and the decision timestamp is cleared', released[0].reviewedAt, null);

  console.log('\nChanging your mind — accepting something previously rejected:');
  await claimProposal(trip.id, proposal.id, 'rejected', ['pending']);
  const rejectedRow = await db.select().from(tripProposals).where(eq(tripProposals.id, proposal.id)).limit(1);
  check('the suggestion is rejected', rejectedRow[0].status, 'rejected');
  check('with a decision timestamp', rejectedRow[0].reviewedAt !== null, true);

  // A plain claim must not resurrect a decision someone already made.
  const blocked = await claimProposal(trip.id, proposal.id, 'accepted', ['pending']);
  check('a pending-only claim cannot re-accept it', blocked, null);

  const reAccepted = await claimProposal(trip.id, proposal.id, 'accepted', ['pending', 'rejected']);
  check('an explicit re-accept succeeds', reAccepted?.status, 'accepted');
  const afterReAccept = await db.select().from(tripProposals).where(eq(tripProposals.id, proposal.id)).limit(1);
  check('status is now accepted', afterReAccept[0].status, 'accepted');

  console.log('\nA re-accept that loses the itinerary race goes back to rejected:');
  await releaseProposal(proposal.id, 'rejected');
  const restored = await db.select().from(tripProposals).where(eq(tripProposals.id, proposal.id)).limit(1);
  check('restored to rejected, not pending', restored[0].status, 'rejected');

  console.log('\nTwo reviewers commit different itineraries at once:');
  const [fresh] = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
  const version = fresh.version;
  const commits = await Promise.all([
    commitPayload(trip.id, version, { itinerary: 'change A' }),
    commitPayload(trip.id, version, { itinerary: 'change B' }),
  ]);
  check('exactly one commit wins', commits.filter(Boolean).length, 1);
  check('the loser gets null (its change is not silently written)', commits.filter((c) => c === null).length, 1);

  const afterCommit = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
  check('version advanced by exactly one', afterCommit[0].version, version + 1);
  check('the stored payload is the winner, not a mix',
    ['change A', 'change B'].includes(JSON.parse(afterCommit[0].payload).itinerary), true);

  console.log('\nThe loser retries on the fresh version (nothing is lost):');
  const winnerPayload = JSON.parse(afterCommit[0].payload);
  const second = await commitPayload(trip.id, afterCommit[0].version, {
    itinerary: `${winnerPayload.itinerary} + retried change`,
  });
  check('the retry succeeds', second !== null, true);
  const final = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
  check('both changes are now present', JSON.parse(final[0].payload).itinerary, 'change A + retried change'.replace('change A', winnerPayload.itinerary));
  check('version advanced again', final[0].version, version + 2);

  console.log('\nA stale version is refused outright:');
  const stale = await commitPayload(trip.id, version, { itinerary: 'overwrite with old state' });
  check('stale commit returns null', stale, null);

  // --- Cleanup -------------------------------------------------------------
  await db.delete(tripProposals).where(eq(tripProposals.tripId, trip.id));
  await db.delete(savedTrips).where(eq(savedTrips.id, trip.id));
  console.log('\nCleaned up test rows.');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
