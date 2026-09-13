import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../db';
import { savedTrips, tripCollaborators, tripProposals } from '../../../../../db/schema';
import { generateItineraryPatch } from '../../../../../agents/refine-itinerary';
import { getTripAccess } from '../../../../../lib/trip-access';
import { eq, and, asc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

function serializeProposal(row: typeof tripProposals.$inferSelect) {
  return {
    id: row.id,
    tripId: row.tripId,
    proposedByUserId: row.proposedByUserId,
    status: row.status,
    suggestedPrompt: row.suggestedPrompt,
    patchData: row.patchData,
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /api/saved-trips/[id]/proposals
// List proposals for a trip the current user owns or collaborates on.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const tripId = params.id;
    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const rows = await db
      .select()
      .from(tripProposals)
      .where(eq(tripProposals.tripId, tripId))
      .orderBy(asc(tripProposals.createdAt));

    return NextResponse.json({ role, proposals: rows.map(serializeProposal) });
  } catch (error) {
    console.error('Proposals GET error:', error);
    return NextResponse.json({ error: 'Failed to load proposals' }, { status: 500 });
  }
}

// POST /api/saved-trips/[id]/proposals
// Friends (or owners) submit a natural-language change suggestion.
// The AI generates a JSON patch; the patch is stored as pending, NOT applied.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const tripId = params.id;
    const body = await req.json().catch(() => ({}));
    const { prompt, dayIndex } = body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }
    // Suggestions raised from a specific day panel carry that day so the AI
    // targets it, while the stored prompt stays exactly what the user typed.
    const day = Number.isInteger(dayIndex) && dayIndex > 0 ? (dayIndex as number) : null;

    // Load the trip and verify the user can collaborate on it.
    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized to suggest changes on this trip' }, { status: 403 });
    }

    // Generate the patch from the current itinerary.
    const payload = JSON.parse(trip.payload || '{}');
    const existingItinerary = payload.itinerary || '';
    if (!existingItinerary) {
      return NextResponse.json({ error: 'Trip has no itinerary to refine' }, { status: 400 });
    }

    const patch = await generateItineraryPatch(
      existingItinerary,
      trip.destination || 'the destination',
      day ? `Day ${day}: ${prompt.trim()}` : prompt.trim(),
    );

    const [proposal] = await db
      .insert(tripProposals)
      .values({
        tripId,
        proposedByUserId: userId,
        suggestedPrompt: prompt.trim(),
        patchData: patch,
      })
      .returning();

    return NextResponse.json({ proposal: serializeProposal(proposal) });
  } catch (error) {
    console.error('Proposal creation error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create proposal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
