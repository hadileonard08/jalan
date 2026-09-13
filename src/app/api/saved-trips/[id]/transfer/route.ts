import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getTripAccess, isOwnerLevel } from '../../../../../lib/trip-access';
import { transferOwnership } from '../../../../../lib/trip-ownership';

export const dynamic = 'force-dynamic';

// POST /api/saved-trips/[id]/transfer
// Hand the trip to another member. Body: { toUserId, keepPreviousOwner? }
//
// Only the current Master Planner can do this, and only to someone already on
// the trip. By default the outgoing Master Planner stays as a Follower; pass
// keepPreviousOwner: false when they are leaving the trip for good.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!isOwnerLevel(role)) {
      return NextResponse.json(
        { error: 'Only the Master Planner can transfer this trip' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const toUserId = typeof body.toUserId === 'string' ? body.toUserId.trim() : '';
    if (!toUserId) return NextResponse.json({ error: 'toUserId is required' }, { status: 400 });

    const result = await transferOwnership({
      tripId: params.id,
      currentOwnerId: trip.userId,
      newOwnerId: toUserId,
      keepPreviousOwner: body.keepPreviousOwner !== false,
    });

    if (!result.ok) {
      const messages: Record<typeof result.reason, [string, number]> = {
        self: ['You are already the Master Planner of this trip', 400],
        'not-a-member': ['That person is not on this trip yet — invite them first', 400],
        'not-owner': ['Only the Master Planner can transfer this trip', 403],
      };
      const [message, status] = messages[result.reason];
      return NextResponse.json({ error: message }, { status });
    }

    return NextResponse.json({
      success: true,
      newOwnerId: result.newOwnerId,
      previousOwnerStays: result.previousOwnerStays,
    });
  } catch (error) {
    console.error('Trip transfer error:', error);
    return NextResponse.json({ error: 'Failed to transfer the trip' }, { status: 500 });
  }
}
