import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { savedTrips } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/saved-trips — list all saved trips for the current user.
export async function GET() {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const trips = await db
      .select()
      .from(savedTrips)
      .where(eq(savedTrips.userId, userId))
      .orderBy(desc(savedTrips.updatedAt));

    // Parse JSON fields for the client.
    const parsed = trips.map((t) => ({
      id: t.id,
      conversationId: t.conversationId || '',
      destination: t.destination,
      dates: t.dates || 'Dates TBD',
      payload: JSON.parse(t.payload),
      todos: JSON.parse(t.todos),
      notes: t.notes,
      feedback: JSON.parse(t.feedback || '{}'),
      flightInfo: JSON.parse(t.flightInfo || '[]'),
      documents: JSON.parse(t.documents || '[]'),
      savedAt: t.createdAt.toISOString(),
    }));

    return NextResponse.json({ trips: parsed });
  } catch (error) {
    console.error('Saved trips GET error:', error);
    return NextResponse.json({ error: 'Failed to load saved trips' }, { status: 500 });
  }
}

// POST /api/saved-trips — create a new saved trip.
// Body: { conversationId, destination, dates, payload }
export async function POST(req: NextRequest) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await req.json();
    const { conversationId, destination, dates, payload } = body;

    if (!destination || !payload) {
      return NextResponse.json({ error: 'destination and payload are required' }, { status: 400 });
    }

    const [trip] = await db
      .insert(savedTrips)
      .values({
        userId,
        conversationId: conversationId || null,
        destination,
        dates: dates || 'Dates TBD',
        payload: JSON.stringify(payload),
        todos: '[]',
        notes: '',
        feedback: '{}',
        flightInfo: '[]',
        documents: '[]',
      })
      .returning();

    return NextResponse.json({
      trip: {
        id: trip.id,
        conversationId: trip.conversationId || '',
        destination: trip.destination,
        dates: trip.dates || 'Dates TBD',
        payload: JSON.parse(trip.payload),
        todos: JSON.parse(trip.todos),
        notes: trip.notes,
        feedback: JSON.parse(trip.feedback || '{}'),
        flightInfo: JSON.parse(trip.flightInfo || '[]'),
        documents: JSON.parse(trip.documents || '[]'),
        savedAt: trip.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Saved trips POST error:', error);
    return NextResponse.json({ error: 'Failed to save trip' }, { status: 500 });
  }
}
