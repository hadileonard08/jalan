import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateItineraryPatchOptions, mergeItineraryPatch } from '../../../../../../agents/refine-itinerary';
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

    const entities = (payload.entities || {}) as {
      destination?: string;
      startDate?: string;
      endDate?: string;
      durationDays?: number;
    };
    const base = {
      destination: trip.destination || entities.destination,
      startDate: entities.startDate,
      endDate: entities.endDate,
      durationDays: entities.durationDays,
    };

    // The drafting thread so far, so a follow-up refines the earlier options
    // instead of starting over.
    const history = Array.isArray(body.history)
      ? (body.history as unknown[])
          .filter((turn): turn is { role: string; content: string } =>
            !!turn && typeof turn === 'object' && typeof (turn as any).content === 'string',
          )
          .slice(-10)
          .map((turn) => ({
            role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: String(turn.content).slice(0, 600),
          }))
      : [];

    const options = await generateItineraryPatchOptions(
      itinerary,
      trip.destination || 'the destination',
      day ? `Day ${day}: ${prompt.trim()}` : prompt.trim(),
      history,
    );

    // Check the itinerary before the change once, so each option can be compared
    // against it. Without the diff, a pre-existing problem on an untouched day
    // (Bali's Day 6 has no time blocks) would be pinned on the suggestion.
    const checked = await Promise.all(
      options.map(async (option) => {
        // A patch that matches nothing is rejected on accept (422), so catching
        // it here saves the Master Planner a dead suggestion.
        const merged = mergeItineraryPatch(itinerary, option.patch);
        const wouldChange = merged !== itinerary;
        if (!wouldChange) return { ...option, wouldChange, findings: { feedback: [], advisory: [] } };

        // Only verify the landmarks this suggestion actually touched.
        const touchedDays = affectedDaysFromPatch(option.patch).map((d) => d.dayNumber);
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

        // Same deterministic checks the generation graph runs, so a suggestion
        // can't smuggle in a hallucinated venue, a wrong day count, a past date,
        // or a date mismatch that nothing else would catch.
        const [before, after] = await Promise.all([
          runItineraryChecks({ itinerary, ...base, landmarkScope: scopeOf(itinerary) }),
          runItineraryChecks({ itinerary: merged, ...base, landmarkScope: scopeOf(merged) }),
        ]);

        const findings: ItineraryCheckResult = {
          feedback: after.feedback.filter((f) => !before.feedback.includes(f)),
          advisory: after.advisory.filter((f) => !before.advisory.includes(f)),
        };
        return { ...option, wouldChange, findings };
      }),
    );

    return NextResponse.json({
      preview: { prompt: prompt.trim(), dayIndex: day, options: checked },
    });
  } catch (error) {
    console.error('Proposal preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to generate a preview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
