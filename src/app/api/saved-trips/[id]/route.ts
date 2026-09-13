import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { savedTrips } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// PATCH /api/saved-trips/[id] — update a saved trip.
// Body: { todos?, notes?, feedback?, flightInfo?, documents? }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await req.json();
    const { todos, notes, feedback, dayFeedback, flightInfo, documents } = body;

    // Build the update object — only update fields that were provided.
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (todos !== undefined) updates.todos = JSON.stringify(todos);
    if (notes !== undefined) updates.notes = notes;
    if (feedback !== undefined) updates.feedback = JSON.stringify(feedback);
    if (dayFeedback !== undefined) updates.dayFeedback = JSON.stringify(dayFeedback);
    if (flightInfo !== undefined) updates.flightInfo = JSON.stringify(flightInfo);
    if (documents !== undefined) updates.documents = JSON.stringify(documents);

    const [updated] = await db
      .update(savedTrips)
      .set(updates)
      .where(and(eq(savedTrips.id, params.id), eq(savedTrips.userId, userId)))
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
        payload: JSON.parse(updated.payload),
        todos: JSON.parse(updated.todos),
        notes: updated.notes,
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

// DELETE /api/saved-trips/[id] — delete a saved trip.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const [deleted] = await db
      .delete(savedTrips)
      .where(and(eq(savedTrips.id, params.id), eq(savedTrips.userId, userId)))
      .returning();

    if (!deleted) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Saved trips DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete trip' }, { status: 500 });
  }
}
