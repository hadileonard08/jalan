import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../../db';
import { tripCollaborators } from '../../../../../../db/schema';
import { getTripAccess, isOwnerLevel } from '../../../../../../lib/trip-access';
import { and, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// DELETE /api/saved-trips/[id]/members/[memberId]
// - memberId = 'me' lets a member leave the trip.
// - Any other memberId requires owner level and removes that person.
// The trip creator can never be removed.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; memberId: string } }
) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!role) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

    const targetUserId = params.memberId === 'me' ? userId : params.memberId;

    if (params.memberId !== 'me' && !isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the Master Planner can remove members' }, { status: 403 });
    }

    if (targetUserId === trip.userId) {
      return NextResponse.json({ error: 'The Master Planner cannot be removed' }, { status: 400 });
    }

    const [removed] = await db
      .delete(tripCollaborators)
      .where(and(eq(tripCollaborators.tripId, params.id), eq(tripCollaborators.userId, targetUserId)))
      .returning();

    if (!removed) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, removedUserId: targetUserId });
  } catch (error) {
    console.error('Member DELETE error:', error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
