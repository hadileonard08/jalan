import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../../db';
import { savedTrips, tripProposals } from '../../../../../../db/schema';
import { mergeItineraryPatch } from '../../../../../../agents/refine-itinerary';
import type { ItineraryPatch } from '../../../../../../lib/chat-state';
import { getTripAccess, isOwnerLevel } from '../../../../../../lib/trip-access';
import { eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// PATCH /api/saved-trips/[id]/proposals/[proposalId]
// Owner-only endpoint to accept or reject a pending AI-generated itinerary patch.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; proposalId: string } }
) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id: tripId, proposalId } = params;
    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (!action || (action !== 'accept' && action !== 'reject')) {
      return NextResponse.json({ error: 'action must be "accept" or "reject"' }, { status: 400 });
    }

    // Only the Master Planner or a Disciple may review proposals.
    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the Master Planner can review proposals' }, { status: 403 });
    }

    // Load the proposal.
    const [proposal] = await db
      .select()
      .from(tripProposals)
      .where(and(eq(tripProposals.id, proposalId), eq(tripProposals.tripId, tripId)))
      .limit(1);

    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }

    if (proposal.status !== 'pending') {
      return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
    }

    if (action === 'reject') {
      const [updated] = await db
        .update(tripProposals)
        .set({ status: 'rejected' })
        .where(eq(tripProposals.id, proposalId))
        .returning();
      return NextResponse.json({
        proposal: {
          id: updated.id,
          tripId: updated.tripId,
          proposedByUserId: updated.proposedByUserId,
          status: updated.status,
          suggestedPrompt: updated.suggestedPrompt,
          patchData: updated.patchData,
          createdAt: updated.createdAt.toISOString(),
        },
      });
    }

    // Accept: merge patch into the saved itinerary.
    const payload = JSON.parse(trip.payload || '{}');
    const currentItinerary = payload.itinerary || '';
    if (!currentItinerary) {
      return NextResponse.json({ error: 'Trip has no itinerary to patch' }, { status: 400 });
    }

    const newItinerary = mergeItineraryPatch(currentItinerary, proposal.patchData as ItineraryPatch);

    // A patch that matches nothing is a silent no-op — report it instead of
    // marking the suggestion accepted while the itinerary stays unchanged.
    if (newItinerary === currentItinerary) {
      return NextResponse.json(
        { error: 'This suggestion no longer matches the itinerary. Ask for a fresh suggestion and try again.' },
        { status: 422 }
      );
    }

    const newPayload = { ...payload, itinerary: newItinerary };

    const [updatedTrip] = await db
      .update(savedTrips)
      .set({ payload: JSON.stringify(newPayload), updatedAt: new Date() })
      .where(eq(savedTrips.id, tripId))
      .returning();

    const [updatedProposal] = await db
      .update(tripProposals)
      .set({ status: 'accepted' })
      .where(eq(tripProposals.id, proposalId))
      .returning();

    return NextResponse.json({
      trip: {
        id: updatedTrip.id,
        conversationId: updatedTrip.conversationId || '',
        destination: updatedTrip.destination,
        dates: updatedTrip.dates || 'Dates TBD',
        weatherAlert: updatedTrip.weatherAlert,
        weatherSnapshot: updatedTrip.weatherSnapshot ? JSON.parse(updatedTrip.weatherSnapshot) : null,
        weatherUpdatedAt: updatedTrip.weatherUpdatedAt ? updatedTrip.weatherUpdatedAt.toISOString() : null,
        payload: JSON.parse(updatedTrip.payload),
        todos: JSON.parse(updatedTrip.todos),
        notes: updatedTrip.notes,
        feedback: JSON.parse(updatedTrip.feedback || '{}'),
        dayFeedback: JSON.parse(updatedTrip.dayFeedback || '{}'),
        flightInfo: JSON.parse(updatedTrip.flightInfo || '[]'),
        documents: JSON.parse(updatedTrip.documents || '[]'),
        savedAt: updatedTrip.createdAt.toISOString(),
      },
      proposal: {
        id: updatedProposal.id,
        tripId: updatedProposal.tripId,
        proposedByUserId: updatedProposal.proposedByUserId,
        status: updatedProposal.status,
        suggestedPrompt: updatedProposal.suggestedPrompt,
        patchData: updatedProposal.patchData,
        createdAt: updatedProposal.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Proposal review error:', error);
    const message = error instanceof Error ? error.message : 'Failed to review proposal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
