import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateItineraryPatch, mergeItineraryPatch } from '../../../../../../agents/refine-itinerary';
import { getTripAccess } from '../../../../../../lib/trip-access';
import { affectedDaysFromPatch } from '../../../../../../lib/refresh-enrichment';
import { runItineraryChecks, type ItineraryCheckResult } from '../../../../../../agents/itinerary-checks';

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

    // Run the same deterministic checks the generation graph uses, so a
    // suggestion can't smuggle in a hallucinated venue, a wrong day count, a
    // past date, or a date mismatch that nothing else would catch.
    let findings: ItineraryCheckResult = { feedback: [], advisory: [] };
    if (wouldChange) {
      const entities = (payload.entities || {}) as {
        destination?: string;
        startDate?: string;
        endDate?: string;
        durationDays?: number;
      };
      const touchedDays = affectedDaysFromPatch(patch).map((d) => d.dayNumber);

      // Only verify the landmarks this suggestion actually touched.
      const scopeOf = (text: string) =>
        touchedDays.length
          ? text
              .split(/(?=#+\s+Day\s+\d+)/i)
              .filter((block) => {
                const m = block.match(/#+\s+Day\s+(\d+)/i);
                return m ? touchedDays.includes(Number(m[1])) : false;
              })
              .join('')
          : undefined;

      const base = {
        destination: trip.destination || entities.destination,
        startDate: entities.startDate,
        endDate: entities.endDate,
        durationDays: entities.durationDays,
      };

      // Check the itinerary before and after, then report only what this
      // suggestion *introduces*. Without the diff, a pre-existing problem on an
      // untouched day (Bali's Day 6 has no time blocks) would be pinned on it.
      const [before, after] = await Promise.all([
        runItineraryChecks({ itinerary, ...base, landmarkScope: scopeOf(itinerary) }),
        runItineraryChecks({ itinerary: merged, ...base, landmarkScope: scopeOf(merged) }),
      ]);

      findings = {
        feedback: after.feedback.filter((f) => !before.feedback.includes(f)),
        advisory: after.advisory.filter((f) => !before.advisory.includes(f)),
      };
    }

    return NextResponse.json({
      preview: { prompt: prompt.trim(), dayIndex: day, patch, wouldChange, findings },
    });
  } catch (error) {
    console.error('Proposal preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to generate a preview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
