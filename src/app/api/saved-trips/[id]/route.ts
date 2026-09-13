import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { savedTrips } from '../../../../db/schema';
import { getTripAccess, isOwnerLevel } from '../../../../lib/trip-access';
import { serializeSavedTrip } from '../../../../lib/serialize-trip';
import { eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/saved-trips/[id] — fetch a single trip the user can access.
// Used by One Stop to pick up itinerary changes accepted elsewhere.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    return NextResponse.json({ trip: serializeSavedTrip(trip), role });
  } catch (error) {
    console.error('Saved trip GET error:', error);
    return NextResponse.json({ error: 'Failed to load trip' }, { status: 500 });
  }
}

// PATCH /api/saved-trips/[id] — update a saved trip.
// Body: { todos?, notes?, feedback?, dayFeedback?, flightInfo?, documents? }
// The itinerary itself is only changed through proposals, so owners,
// Disciples, and Followers can all update the collaborative fields.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await req.json();
    const { todos, notes, noteEntries, feedback, dayFeedback, flightInfo, documents } = body;

    // Build the update object — only update fields that were provided.
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (todos !== undefined) updates.todos = JSON.stringify(todos);
    if (notes !== undefined) updates.notes = notes;
    if (noteEntries !== undefined) updates.noteEntries = JSON.stringify(noteEntries);
    if (feedback !== undefined) updates.feedback = JSON.stringify(feedback);
    if (dayFeedback !== undefined) updates.dayFeedback = JSON.stringify(dayFeedback);
    if (flightInfo !== undefined) updates.flightInfo = JSON.stringify(flightInfo);
    if (documents !== undefined) updates.documents = JSON.stringify(documents);

    const [updated] = await db
      .update(savedTrips)
      .set(updates)
      .where(eq(savedTrips.id, params.id))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }

    return NextResponse.json({
      trip: {
        id: updated.id,
        conversationId: updated.conversationId || '',
        destination: updated.destination,
        dates: updated.dates || 'Dates TBD',
        weatherAlert: updated.weatherAlert,
        weatherSnapshot: updated.weatherSnapshot ? JSON.parse(updated.weatherSnapshot) : null,
        weatherUpdatedAt: updated.weatherUpdatedAt ? updated.weatherUpdatedAt.toISOString() : null,
        payload: JSON.parse(updated.payload),
        todos: JSON.parse(updated.todos),
        notes: updated.notes,
        noteEntries: JSON.parse(updated.noteEntries || '[]'),
        feedback: JSON.parse(updated.feedback || '{}'),
        dayFeedback: JSON.parse(updated.dayFeedback || '{}'),
        flightInfo: JSON.parse(updated.flightInfo || '[]'),
        documents: JSON.parse(updated.documents || '[]'),
        savedAt: updated.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Saved trips PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update trip' }, { status: 500 });
  }
}

// DELETE /api/saved-trips/[id] — delete a saved trip (owner level only).
// Followers and Disciples leave a trip through the members endpoint instead.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!isOwnerLevel(role)) {
      return NextResponse.json(
        { error: 'Only the Master Planner can delete this trip. Leave the trip instead.' },
        { status: 403 }
      );
    }

    await db.delete(savedTrips).where(and(eq(savedTrips.id, params.id), eq(savedTrips.userId, trip.userId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Saved trips DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete trip' }, { status: 500 });
  }
}
