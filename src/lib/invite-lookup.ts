import { db } from '../db';
import { savedTrips, tripInvites } from '../db/schema';
import { eq } from 'drizzle-orm';
import { resolveClerkUsers } from './clerk-users';

// Shared invite lookup, used by the invite API and by the link-preview metadata.

export async function loadInvite(token: string) {
  const [invite] = await db.select().from(tripInvites).where(eq(tripInvites.token, token)).limit(1);
  if (!invite) return { invite: null, trip: null, expired: false };

  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return { invite, trip: null, expired: true };
  }

  const [trip] = await db.select().from(savedTrips).where(eq(savedTrips.id, invite.tripId)).limit(1);
  return { invite, trip: trip || null, expired: false };
}

export interface InvitePreview {
  destination: string;
  dates: string;
  inviterName: string | null;
}

// What a link preview should say about an invite. Returns null when the token is
// unknown or expired, so callers can fall back to a generic card.
export async function loadInvitePreview(token: string): Promise<InvitePreview | null> {
  const { invite, trip } = await loadInvite(token);
  if (!invite || !trip) return null;

  // Best-effort: a missing name just means a less personal preview.
  let inviterName: string | null = null;
  try {
    const profiles = await resolveClerkUsers([invite.createdByUserId]);
    inviterName = profiles[invite.createdByUserId]?.name || null;
  } catch { /* keep the generic wording */ }

  return {
    destination: trip.destination || 'a trip',
    dates: trip.dates || 'Dates TBD',
    inviterName,
  };
}
