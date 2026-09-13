import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../db';
import { tripCollaborators } from '../../../../../db/schema';
import { getTripAccess } from '../../../../../lib/trip-access';
import { resolveClerkUsers } from '../../../../../lib/clerk-users';
import { asc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/saved-trips/[id]/members — list everyone on the trip (any member).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!role) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

    const rows = await db
      .select()
      .from(tripCollaborators)
      .where(eq(tripCollaborators.tripId, params.id))
      .orderBy(asc(tripCollaborators.createdAt));

    const members = [
      { userId: trip.userId, role: 'owner' as const, isCreator: true, joinedAt: trip.createdAt.toISOString() },
      ...rows
        .filter((row) => row.userId !== trip.userId)
        .map((row) => ({
          userId: row.userId,
          role: (row.role === 'owner' ? 'co-planner' : 'collaborator') as 'co-planner' | 'collaborator',
          isCreator: false,
          joinedAt: row.createdAt.toISOString(),
        })),
    ];

    // Attach real names/avatars from Clerk so the UI doesn't show raw IDs.
    const profiles = await resolveClerkUsers(members.map((m) => m.userId));

    return NextResponse.json({
      members: members.map((member) => ({
        ...member,
        name: profiles[member.userId]?.name ?? null,
        email: profiles[member.userId]?.email ?? null,
        imageUrl: profiles[member.userId]?.imageUrl ?? null,
      })),
    });
  } catch (error) {
    console.error('Members GET error:', error);
    return NextResponse.json({ error: 'Failed to load members' }, { status: 500 });
  }
}
