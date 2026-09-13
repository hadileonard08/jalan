import { db } from '../db';
import { savedTrips, tripCollaborators } from '../db/schema';
import { and, eq } from 'drizzle-orm';

// Ownership transfer. The Master Planner is whoever `saved_trips.user_id` points
// at, so handing the trip over is a change to that column — plus bookkeeping so
// both people keep the access they expect afterwards.

export type TransferOutcome =
  | { ok: true; previousOwnerId: string; newOwnerId: string; previousOwnerStays: boolean }
  | { ok: false; reason: 'self' | 'not-a-member' | 'not-owner' };

export async function transferOwnership({
  tripId,
  currentOwnerId,
  newOwnerId,
  keepPreviousOwner = true,
}: {
  tripId: string;
  currentOwnerId: string;
  newOwnerId: string;
  /** Leave the outgoing Master Planner on the trip as a Follower. */
  keepPreviousOwner?: boolean;
}): Promise<TransferOutcome> {
  if (currentOwnerId === newOwnerId) return { ok: false, reason: 'self' };

  // Confirm the caller really owns the trip before saying anything about the
  // target, so a non-owner is told that rather than something misleading.
  const [trip] = await db
    .select({ userId: savedTrips.userId })
    .from(savedTrips)
    .where(eq(savedTrips.id, tripId))
    .limit(1);
  if (!trip || trip.userId !== currentOwnerId) return { ok: false, reason: 'not-owner' };

  // The new owner must already be on the trip — no handing a trip to a stranger.
  const [member] = await db
    .select()
    .from(tripCollaborators)
    .where(and(eq(tripCollaborators.tripId, tripId), eq(tripCollaborators.userId, newOwnerId)))
    .limit(1);
  if (!member) return { ok: false, reason: 'not-a-member' };

  // Compare-and-swap on ownership: if two transfers run at once, only the one
  // whose `currentOwnerId` still matches the row wins.
  const [updated] = await db
    .update(savedTrips)
    .set({ userId: newOwnerId, updatedAt: new Date() })
    .where(and(eq(savedTrips.id, tripId), eq(savedTrips.userId, currentOwnerId)))
    .returning();
  // Lost the race to another transfer that committed first.
  if (!updated) return { ok: false, reason: 'not-owner' };

  // The new owner is identified by user_id now, so their member row is redundant.
  await db
    .delete(tripCollaborators)
    .where(and(eq(tripCollaborators.tripId, tripId), eq(tripCollaborators.userId, newOwnerId)));

  // The outgoing owner either becomes a Follower (handover) or leaves entirely.
  await db
    .delete(tripCollaborators)
    .where(and(eq(tripCollaborators.tripId, tripId), eq(tripCollaborators.userId, currentOwnerId)));
  if (keepPreviousOwner) {
    await db
      .insert(tripCollaborators)
      .values({ tripId, userId: currentOwnerId, role: 'collaborator' });
  }

  return {
    ok: true,
    previousOwnerId: currentOwnerId,
    newOwnerId,
    previousOwnerStays: keepPreviousOwner,
  };
}
