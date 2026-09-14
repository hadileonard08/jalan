import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateItineraryPatch, mergeItineraryPatch } from '../../../../../../agents/refine-itinerary';
import { getTripAccess } from '../../../../../../lib/trip-access';
import { eveningFeasibilityWarning } from '../../../../../../lib/itinerary-feasibility';

export const dynamic = 'force-dynamic';

// POST /api/saved-trips/[id]/proposals/preview
// Generates the AI patch for a suggestion WITHOUT storing it, so the suggester
// can check it before it reaches the Master Planner's queue. Body: { prompt, dayIndex? }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!role) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { prompt, dayIndex } = body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }
    const day = Number.isInteger(dayIndex) && dayIndex > 0 ? (dayIndex as number) : null;

    const payload = JSON.parse(trip.payload || '{}');
    const itinerary = payload.itinerary || '';
    if (!itinerary) {
      return NextResponse.json({ error: 'Trip has no itinerary to refine' }, { status: 400 });
    }

    const patch = await generateItineraryPatch(
      itinerary,
      trip.destination || 'the destination',
      day ? `Day ${day}: ${prompt.trim()}` : prompt.trim(),
    );

    // Tell the suggester up front whether this would actually change anything.
    // A patch that matches nothing is rejected on accept (422), so catching it
    // here saves the Master Planner a dead suggestion.
    const merged = mergeItineraryPatch(itinerary, patch);
    const wouldChange = merged !== itinerary;

    // Warn when the change lands a venue that closes in the late afternoon in the
    // Evening block — the suggester can fix it before it reaches the reviewer.
    const warning = wouldChange ? eveningFeasibilityWarning(merged) : null;

    return NextResponse.json({
      preview: { prompt: prompt.trim(), dayIndex: day, patch, wouldChange, warning },
    });
  } catch (error) {
    console.error('Proposal preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to generate a preview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
