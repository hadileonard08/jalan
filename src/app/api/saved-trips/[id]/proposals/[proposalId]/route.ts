import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../../db';
import { savedTrips, tripProposals } from '../../../../../../db/schema';
import { generateItineraryPatch, mergeItineraryPatch } from '../../../../../../agents/refine-itinerary';
import type { ItineraryPatch } from '../../../../../../lib/chat-state';
import { getTripAccess, isOwnerLevel } from '../../../../../../lib/trip-access';
import { serializeSavedTrip } from '../../../../../../lib/serialize-trip';
import { refreshEnrichment, affectedDaysFromPatch } from '../../../../../../lib/refresh-enrichment';
import { claimProposal, releaseProposal, commitPayload } from '../../../../../../lib/proposal-review';
import { eq, and } from 'drizzle-orm';

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

// Loads the proposal plus the caller's access, enforcing that pending-only
// actions really are pending.
async function loadPendingProposal(tripId: string, proposalId: string) {
  const [proposal] = await db
    .select()
    .from(tripProposals)
    .where(and(eq(tripProposals.id, proposalId), eq(tripProposals.tripId, tripId)))
    .limit(1);
  return proposal || null;
}

// PATCH /api/saved-trips/[id]/proposals/[proposalId]
// Owner-level endpoint to accept or reject a pending AI-generated itinerary patch.
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

    // Only the Master Planner or Master Planner Support may review proposals.
    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the Master Planner can review proposals' }, { status: 403 });
    }

    const proposal = await loadPendingProposal(tripId, proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }

    if (proposal.status !== 'pending') {
      return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
    }

    if (action === 'reject') {
      // Atomic claim: if another reviewer already decided, this matches no row.
      const rejected = await claimProposal(tripId, proposalId, 'rejected');
      if (!rejected) {
        return NextResponse.json(
          { error: 'Another reviewer already handled this suggestion.' },
          { status: 409 },
        );
      }
      return NextResponse.json({ proposal: serializeProposal(rejected) });
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

    // Claim the suggestion BEFORE the expensive work, so two concurrent accepts
    // cannot both run enrichment for the same patch. The status transition is
    // the lock — only one caller can move it out of `pending`.
    const claimed = await claimProposal(tripId, proposalId, 'accepted');
    if (!claimed) {
      return NextResponse.json(
        { error: 'Another reviewer already handled this suggestion.' },
        { status: 409 },
      );
    }

    // An approved edit changes the *stops*, so the parts of the trip that
    // describe them must be rebuilt: the day's hero image, its route link, its
    // map waypoints, and the transport notes inside the text. Best-effort — the
    // text change is what the user approved, so a slow or failing enrichment
    // must never fail the approval.
    const patch = proposal.patchData as ItineraryPatch;
    let newPayload = { ...payload, itinerary: newItinerary };
    try {
      newPayload = await refreshEnrichment(
        newPayload,
        trip.destination || '',
        affectedDaysFromPatch(patch),
      );
    } catch (error) {
      console.warn('[Proposal] enrichment refresh failed, keeping the patched text:', error);
    }

    // Compare-and-swap: if another reviewer committed while this request was
    // enriching, our `payload` copy is stale. Writing it anyway would silently
    // drop their change, so hand the suggestion back and ask for a retry.
    const updatedTrip = await commitPayload(tripId, trip.version, newPayload);
    if (!updatedTrip) {
      await releaseProposal(proposalId);
      return NextResponse.json(
        { error: 'The trip changed while this suggestion was being applied. Please review it again.' },
        { status: 409 },
      );
    }

    return NextResponse.json({
      trip: serializeSavedTrip(updatedTrip),
      proposal: serializeProposal(claimed),
    });
  } catch (error) {
    console.error('Proposal review error:', error);
    const message = error instanceof Error ? error.message : 'Failed to review proposal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT /api/saved-trips/[id]/proposals/[proposalId]
// The suggester can reword their own pending suggestion; the AI regenerates
// the patch in place. Body: { prompt, dayIndex? }
export async function PUT(
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
    const { prompt, dayIndex } = body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const proposal = await loadPendingProposal(tripId, proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (proposal.proposedByUserId !== userId) {
      return NextResponse.json({ error: 'Only the suggester can edit this suggestion' }, { status: 403 });
    }
    if (proposal.status !== 'pending') {
      return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
    }

    const payload = JSON.parse(trip.payload || '{}');
    const existingItinerary = payload.itinerary || '';
    if (!existingItinerary) {
      return NextResponse.json({ error: 'Trip has no itinerary to refine' }, { status: 400 });
    }

    const day = Number.isInteger(dayIndex) && dayIndex > 0 ? (dayIndex as number) : null;
    const patch = await generateItineraryPatch(
      existingItinerary,
      trip.destination || 'the destination',
      day ? `Day ${day}: ${prompt.trim()}` : prompt.trim(),
    );

    const [updated] = await db
      .update(tripProposals)
      .set({ suggestedPrompt: prompt.trim(), patchData: patch })
      .where(eq(tripProposals.id, proposalId))
      .returning();

    return NextResponse.json({ proposal: serializeProposal(updated) });
  } catch (error) {
    console.error('Proposal update error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update proposal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/saved-trips/[id]/proposals/[proposalId]
// The suggester can withdraw their own pending suggestion; owner level can
// withdraw any pending one. Reviewed suggestions are kept for the record.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; proposalId: string } }
) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id: tripId, proposalId } = params;

    const { trip, role } = await getTripAccess(tripId, userId);
    if (!trip) {
      return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    }
    if (!role) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const proposal = await loadPendingProposal(tripId, proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (proposal.proposedByUserId !== userId && !isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the suggester can withdraw this suggestion' }, { status: 403 });
    }
    if (proposal.status !== 'pending') {
      return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
    }

    await db.delete(tripProposals).where(eq(tripProposals.id, proposalId));

    return NextResponse.json({ success: true, withdrawnId: proposalId });
  } catch (error) {
    console.error('Proposal delete error:', error);
    return NextResponse.json({ error: 'Failed to withdraw proposal' }, { status: 500 });
  }
}
