import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../db';
import { tripProposals } from '../../../../../db/schema';
import { eq } from 'drizzle-orm';
import { getTripAccess } from '../../../../../lib/trip-access';
import { buildTripFeed } from '../../../../../lib/trip-feed';
import type { TripProposal } from '../../../../../lib/chat-state';
import { resolveClerkUsers } from '../../../../../lib/clerk-users';

export const dynamic = 'force-dynamic';

// GET /api/saved-trips/[id]/feed[?day=N]
// One chronological timeline of a trip's comments and AI proposals, ascending.
// Omit `day` for the whole trip.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!role) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

    const dayParam = req.nextUrl.searchParams.get('day');
    const day = dayParam && /^\d+$/.test(dayParam) ? Number(dayParam) : undefined;

    const payload = JSON.parse(trip.payload || '{}');
    const rows = await db.select().from(tripProposals).where(eq(tripProposals.tripId, params.id));

    const proposals: TripProposal[] = rows.map((row) => ({
      id: row.id,
      tripId: row.tripId,
      proposedByUserId: row.proposedByUserId,
      status: row.status,
      suggestedPrompt: row.suggestedPrompt,
      patchData: row.patchData as TripProposal['patchData'],
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    }));

    const items = buildTripFeed({ dayFeedback: payload.dayFeedback, proposals, day });

    // Comments store the literal author "You" — they are written client-side into
    // the payload — so only proposal authors can be resolved to a real name.
    const authorIds = [...new Set(items.filter((i) => i.type === 'proposal').map((i) => i.author))];
    const profiles: Record<string, { name?: string | null; imageUrl?: string | null }> =
      authorIds.length ? await resolveClerkUsers(authorIds).catch(() => ({})) : {};

    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        authorName: profiles[item.author]?.name || item.author,
        authorAvatarUrl: profiles[item.author]?.imageUrl || null,
      })),
    });
  } catch (error) {
    console.error('Trip feed error:', error);
    return NextResponse.json({ error: 'Failed to load the feed' }, { status: 500 });
  }
}
