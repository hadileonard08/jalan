import { db } from '../db';
import { savedTrips, tripCollaborators } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// Two roles only: the trip's creator is the Master Planner, and everyone invited
// to the trip is a Follower. Followers can suggest changes and comment, but only
// the Master Planner can approve, invite, remove members, or delete the trip.
export type TripRole = 'owner' | 'collaborator';

export function isOwnerLevel(role: TripRole | null) {
  return role === 'owner';
}

export async function getTripAccess(tripId: string, userId: string) {
  const [trip] = await db.select().from(savedTrips).where(eq(savedTrips.id, tripId)).limit(1);
  if (!trip) return { trip: null, role: null as TripRole | null };

  if (trip.userId === userId) return { trip, role: 'owner' as TripRole };

  const [member] = await db
    .select()
    .from(tripCollaborators)
    .where(and(eq(tripCollaborators.tripId, tripId), eq(tripCollaborators.userId, userId)))
    .limit(1);

  if (!member) return { trip, role: null as TripRole | null };

  // Any member row is a Follower. A legacy row stored as 'owner' no longer
  // grants owner-level rights — the creator is the only Master Planner.
  return { trip, role: 'collaborator' as TripRole };
}
