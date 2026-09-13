/**
 * Test: trip roles — Master Planner vs Follower.
 *
 * Only two roles exist now: the trip's creator is the Master Planner, everyone
 * invited is a Follower. This pins that down, including that a legacy
 * trip_collaborators row stored as 'owner' no longer grants owner-level rights.
 *
 * Usage:
 *   npx tsx scripts/test-trip-access.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { savedTrips, tripCollaborators } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { getTripAccess, isOwnerLevel } from '../src/lib/trip-access';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const CREATOR = '__test_creator__';
const FOLLOWER = '__test_follower__';
const LEGACY_OWNER = '__test_legacy_owner__';
const STRANGER = '__test_stranger__';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: trip roles (Master Planner / Follower)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const [trip] = await db
    .insert(savedTrips)
    .values({
      userId: CREATOR,
      destination: '__roles_test__',
      dates: '2027-01-01',
      payload: JSON.stringify({ itinerary: '### Day 1\nx' }),
    })
    .returning();

  await db.insert(tripCollaborators).values([
    { tripId: trip.id, userId: FOLLOWER, role: 'collaborator' },
    // A row from before the role was removed.
    { tripId: trip.id, userId: LEGACY_OWNER, role: 'owner' },
  ]);

  const creator = await getTripAccess(trip.id, CREATOR);
  const follower = await getTripAccess(trip.id, FOLLOWER);
  const legacy = await getTripAccess(trip.id, LEGACY_OWNER);
  const stranger = await getTripAccess(trip.id, STRANGER);

  console.log('Roles:');
  check('creator is the Master Planner', creator.role, 'owner');
  check('an invited member is a Follower', follower.role, 'collaborator');
  check('a legacy "owner" member row is downgraded to Follower', legacy.role, 'collaborator');
  check('a non-member has no access', stranger.role, null);

  console.log('\nWho can approve, invite, remove members or delete:');
  check('Master Planner', isOwnerLevel(creator.role), true);
  check('Follower', isOwnerLevel(follower.role), false);
  check('legacy owner row', isOwnerLevel(legacy.role), false);
  check('non-member', isOwnerLevel(stranger.role), false);

  console.log('\nWho can suggest or comment:');
  check('Master Planner', creator.role !== null, true);
  check('Follower', follower.role !== null, true);
  check('non-member', stranger.role !== null, false);

  // --- Cleanup -------------------------------------------------------------
  await db.delete(tripCollaborators).where(eq(tripCollaborators.tripId, trip.id));
  await db.delete(savedTrips).where(eq(savedTrips.id, trip.id));
  console.log('\nCleaned up test rows.');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
