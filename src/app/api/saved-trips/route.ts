import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { savedTrips, tripCollaborators } from '../../../db/schema';
import { eq, desc, and, inArray } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// Parse JSON fields for the client.
function serializeTrip(t: typeof savedTrips.$inferSelect) {
  return {
    id: t.id,
    conversationId: t.conversationId || '',
    destination: t.destination,
    dates: t.dates || 'Dates TBD',
    weatherAlert: t.weatherAlert,
    weatherSnapshot: t.weatherSnapshot ? JSON.parse(t.weatherSnapshot) : null,
    weatherUpdatedAt: t.weatherUpdatedAt ? t.weatherUpdatedAt.toISOString() : null,
    payload: JSON.parse(t.payload),
    todos: JSON.parse(t.todos),
    notes: t.notes,
    feedback: JSON.parse(t.feedback || '{}'),
    dayFeedback: JSON.parse(t.dayFeedback || '{}'),
    flightInfo: JSON.parse(t.flightInfo || '[]'),
    documents: JSON.parse(t.documents || '[]'),
    savedAt: t.createdAt.toISOString(),
  };
}

// GET /api/saved-trips — list the trips the user owns plus any they were
// invited to as a Master Planner Disciple or Follower.
export async function GET() {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const owned = await db
      .select()
      .from(savedTrips)
      .where(eq(savedTrips.userId, userId))
      .orderBy(desc(savedTrips.updatedAt));

    const memberships = await db
      .select()
      .from(tripCollaborators)
      .where(eq(tripCollaborators.userId, userId));

    const ownedIds = new Set(owned.map((t) => t.id));
    const sharedIds = memberships.map((m) => m.tripId).filter((id) => !ownedIds.has(id));
    const shared = sharedIds.length
      ? await db.select().from(savedTrips).where(inArray(savedTrips.id, sharedIds))
      : [];

    const trips = [...owned, ...shared].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );

    return NextResponse.json({ trips: trips.map(serializeTrip) });
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

    // Duplicate detection: if the user already has a trip with the same
    // conversationId (same chat) OR same destination + dates, return the
    // existing trip instead of creating a duplicate.
    const normalizedDates = (dates || 'Dates TBD').trim();

    // Check by conversationId first (most reliable — same chat = same trip).
    if (conversationId) {
      const existingByConv = await db
        .select()
        .from(savedTrips)
        .where(and(eq(savedTrips.userId, userId), eq(savedTrips.conversationId, conversationId)))
        .limit(1);
      if (existingByConv.length > 0) {
        const t = existingByConv[0];
        return NextResponse.json({
          trip: {
            id: t.id,
            conversationId: t.conversationId || '',
            destination: t.destination,
            dates: t.dates || 'Dates TBD',
            weatherAlert: t.weatherAlert,
            weatherSnapshot: t.weatherSnapshot ? JSON.parse(t.weatherSnapshot) : null,
            weatherUpdatedAt: t.weatherUpdatedAt ? t.weatherUpdatedAt.toISOString() : null,
            payload: JSON.parse(t.payload),
            todos: JSON.parse(t.todos),
            notes: t.notes,
            feedback: JSON.parse(t.feedback || '{}'),
            dayFeedback: JSON.parse(t.dayFeedback || '{}'),
            flightInfo: JSON.parse(t.flightInfo || '[]'),
            documents: JSON.parse(t.documents || '[]'),
            savedAt: t.createdAt.toISOString(),
          },
          duplicate: true,
        });
      }
    }

    // Check by destination + dates (same place, same dates = likely same trip).
    const existingByDest = await db
      .select()
      .from(savedTrips)
      .where(and(
        eq(savedTrips.userId, userId),
        eq(savedTrips.destination, destination),
        eq(savedTrips.dates, normalizedDates),
      ))
      .limit(1);
    if (existingByDest.length > 0) {
      const t = existingByDest[0];
      return NextResponse.json({
        trip: {
          id: t.id,
          conversationId: t.conversationId || '',
          destination: t.destination,
          dates: t.dates || 'Dates TBD',
          weatherAlert: t.weatherAlert,
          weatherSnapshot: t.weatherSnapshot ? JSON.parse(t.weatherSnapshot) : null,
          weatherUpdatedAt: t.weatherUpdatedAt ? t.weatherUpdatedAt.toISOString() : null,
          payload: JSON.parse(t.payload),
          todos: JSON.parse(t.todos),
          notes: t.notes,
          feedback: JSON.parse(t.feedback || '{}'),
          dayFeedback: JSON.parse(t.dayFeedback || '{}'),
          flightInfo: JSON.parse(t.flightInfo || '[]'),
          documents: JSON.parse(t.documents || '[]'),
          savedAt: t.createdAt.toISOString(),
        },
        duplicate: true,
      });
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
        dayFeedback: '{}',
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
        weatherAlert: trip.weatherAlert,
        weatherSnapshot: trip.weatherSnapshot ? JSON.parse(trip.weatherSnapshot) : null,
        weatherUpdatedAt: trip.weatherUpdatedAt ? trip.weatherUpdatedAt.toISOString() : null,
        payload: JSON.parse(trip.payload),
        todos: JSON.parse(trip.todos),
        notes: trip.notes,
        feedback: JSON.parse(trip.feedback || '{}'),
        dayFeedback: JSON.parse(trip.dayFeedback || '{}'),
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
