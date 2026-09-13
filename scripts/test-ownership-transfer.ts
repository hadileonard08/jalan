/**
 * Test: Master Planner ownership transfer.
 *
 * The Master Planner is whoever saved_trips.user_id points at, so a handover has
 * to move that column and keep both people's access correct afterwards.
 *
 * Usage:
 *   npx tsx scripts/test-ownership-transfer.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { savedTrips, tripCollaborators } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { getTripAccess, isOwnerLevel } from '../src/lib/trip-access';
import { transferOwnership } from '../src/lib/trip-ownership';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const OWNER = '__test_owner__';
const FOLLOWER = '__test_follower__';
const OUTSIDER = '__test_outsider__';

async function makeTrip() {
  const [trip] = await db
    .insert(savedTrips)
    .values({
      userId: OWNER,
      destination: '__transfer_test__',
      dates: '2027-01-01',
      payload: JSON.stringify({ itinerary: '### Day 1\nx' }),
    })
    .returning();
  await db.insert(tripCollaborators).values({ tripId: trip.id, userId: FOLLOWER, role: 'collaborator' });
  return trip;
}

async function cleanup(tripId: string) {
  await db.delete(tripCollaborators).where(eq(tripCollaborators.tripId, tripId));
  await db.delete(savedTrips).where(eq(savedTrips.id, tripId));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: Master Planner ownership transfer');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Guards:');
  {
    const trip = await makeTrip();
    const toSelf = await transferOwnership({ tripId: trip.id, currentOwnerId: OWNER, newOwnerId: OWNER });
    check('cannot transfer to yourself', toSelf, { ok: false, reason: 'self' });

    const toStranger = await transferOwnership({ tripId: trip.id, currentOwnerId: OWNER, newOwnerId: OUTSIDER });
    check('cannot transfer to a non-member', toStranger, { ok: false, reason: 'not-a-member' });

    const byNonOwner = await transferOwnership({ tripId: trip.id, currentOwnerId: FOLLOWER, newOwnerId: OUTSIDER });
    check('a non-owner cannot transfer', byNonOwner, { ok: false, reason: 'not-owner' });

    const still = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
    check('ownership unchanged after failed attempts', still[0].userId, OWNER);
    await cleanup(trip.id);
  }

  console.log('\nHandover (previous owner stays as a Follower):');
  {
    const trip = await makeTrip();
    const result = await transferOwnership({ tripId: trip.id, currentOwnerId: OWNER, newOwnerId: FOLLOWER });
    check('transfer succeeds', result.ok, true);

    const [row] = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
    check('the trip is now owned by the new Master Planner', row.userId, FOLLOWER);

    const newOwner = await getTripAccess(trip.id, FOLLOWER);
    check('the new owner can approve', isOwnerLevel(newOwner.role), true);

    const oldOwner = await getTripAccess(trip.id, OWNER);
    check('the outgoing owner is now a Follower', oldOwner.role, 'collaborator');
    check('the outgoing owner cannot approve', isOwnerLevel(oldOwner.role), false);

    const rows = await db.select().from(tripCollaborators).where(eq(tripCollaborators.tripId, trip.id));
    check('exactly one member row, for the outgoing owner', rows.length, 1);
    check('no duplicate row for the new owner', rows.filter((r) => r.userId === FOLLOWER).length, 0);
    await cleanup(trip.id);
  }

  console.log('\nHandover where the outgoing owner leaves entirely:');
  {
    const trip = await makeTrip();
    await transferOwnership({
      tripId: trip.id,
      currentOwnerId: OWNER,
      newOwnerId: FOLLOWER,
      keepPreviousOwner: false,
    });

    const oldOwner = await getTripAccess(trip.id, OWNER);
    check('the outgoing owner has no access', oldOwner.role, null);
    const rows = await db.select().from(tripCollaborators).where(eq(tripCollaborators.tripId, trip.id));
    check('no member rows remain', rows.length, 0);
    await cleanup(trip.id);
  }

  console.log('\nTwo transfers racing:');
  {
    const trip = await makeTrip();
    const [a, b] = await Promise.all([
      transferOwnership({ tripId: trip.id, currentOwnerId: OWNER, newOwnerId: FOLLOWER }),
      transferOwnership({ tripId: trip.id, currentOwnerId: OWNER, newOwnerId: OUTSIDER }),
    ]);
    check('exactly one transfer wins', [a.ok, b.ok].filter(Boolean).length, 1);
    const [row] = await db.select().from(savedTrips).where(eq(savedTrips.id, trip.id)).limit(1);
    check('the trip ends up with exactly one owner', [FOLLOWER, OUTSIDER].includes(row.userId), true);
    await cleanup(trip.id);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
