import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { randomBytes } from 'crypto';
import { db } from '../../../../../db';
import { tripInvites } from '../../../../../db/schema';
import { getTripAccess, isOwnerLevel } from '../../../../../lib/trip-access';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const INVITE_TTL_DAYS = 30;

function serializeInvite(row: typeof tripInvites.$inferSelect) {
  return {
    id: row.id,
    token: row.token,
    role: row.role,
    url: `/invite/${row.token}`,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /api/saved-trips/[id]/invites — list active invite links (owner level only).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the Master Planner can manage invites' }, { status: 403 });
    }

    const rows = await db
      .select()
      .from(tripInvites)
      .where(
        and(
          eq(tripInvites.tripId, params.id),
          or(isNull(tripInvites.expiresAt), gt(tripInvites.expiresAt, new Date())),
        )
      )
      .orderBy(desc(tripInvites.createdAt));

    return NextResponse.json({ invites: rows.map(serializeInvite) });
  } catch (error) {
    console.error('Invites GET error:', error);
    return NextResponse.json({ error: 'Failed to load invites' }, { status: 500 });
  }
}

// POST /api/saved-trips/[id]/invites — create an invite link (owner level only).
// Body: { role: 'owner' | 'collaborator' }  ('owner' = Master Planner Support)
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { trip, role } = await getTripAccess(params.id, userId);
    if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });
    if (!isOwnerLevel(role)) {
      return NextResponse.json({ error: 'Only the Master Planner can invite people' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const inviteRole = body.role === 'owner' ? 'owner' : 'collaborator';
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const [invite] = await db
      .insert(tripInvites)
      .values({ tripId: params.id, token, role: inviteRole, createdByUserId: userId, expiresAt })
      .returning();

    return NextResponse.json({ invite: serializeInvite(invite) });
  } catch (error) {
    console.error('Invites POST error:', error);
    return NextResponse.json({ error: 'Failed to create invite' }, { status: 500 });
  }
}
