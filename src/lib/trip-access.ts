import { db } from '../db';
import { savedTrips, tripCollaborators } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// The trip's creator is the Master Planner. A trip_collaborators row with
// role 'owner' is a Master Planner Support (co-planner); anything else in
// that table is a Follower (collaborator).
export type TripRole = 'owner' | 'co-planner' | 'collaborator';

export function isOwnerLevel(role: TripRole | null) {
  return role === 'owner' || role === 'co-planner';
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
  return {
    trip,
    role: (member.role === 'owner' ? 'co-planner' : 'collaborator') as TripRole,
  };
}
