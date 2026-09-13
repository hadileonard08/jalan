import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { savedTrips, tripCollaborators, tripInvites } from '../../../../db/schema';
import { and, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

function roleLabel(role: 'owner' | 'collaborator') {
  return role === 'owner' ? 'Master Planner Support' : 'Follower';
}

async function loadInvite(token: string) {
  const [invite] = await db.select().from(tripInvites).where(eq(tripInvites.token, token)).limit(1);
  if (!invite) return { invite: null, trip: null, expired: false };
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return { invite, trip: null, expired: true };
  }
  const [trip] = await db.select().from(savedTrips).where(eq(savedTrips.id, invite.tripId)).limit(1);
  return { invite, trip: trip || null, expired: false };
}

// GET /api/invites/[token] — what am I joining?
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const { invite, trip, expired } = await loadInvite(params.token);
    if (!invite) return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    if (expired || !trip) return NextResponse.json({ error: 'Invite expired' }, { status: 410 });

    const userId = auth().userId;
    let alreadyMember = false;
    if (userId) {
      if (trip.userId === userId) {
        alreadyMember = true;
      } else {
        const [member] = await db
          .select()
          .from(tripCollaborators)
          .where(and(eq(tripCollaborators.tripId, trip.id), eq(tripCollaborators.userId, userId)))
          .limit(1);
        alreadyMember = !!member;
      }
    }

    return NextResponse.json({
      invite: {
        role: invite.role,
        roleLabel: roleLabel(invite.role),
        expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      },
      trip: {
        id: trip.id,
        destination: trip.destination,
        dates: trip.dates || 'Dates TBD',
      },
      alreadyMember,
    });
  } catch (error) {
    console.error('Invite GET error:', error);
    return NextResponse.json({ error: 'Failed to load invite' }, { status: 500 });
  }
}

// POST /api/invites/[token] — join the trip with the invited role.
export async function POST(_req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const userId = auth().userId;
    if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { invite, trip, expired } = await loadInvite(params.token);
    if (!invite) return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    if (expired || !trip) return NextResponse.json({ error: 'Invite expired' }, { status: 410 });

    // The creator already has full access.
    if (trip.userId === userId) {
      return NextResponse.json({ tripId: trip.id, role: 'owner', alreadyMember: true });
    }

    const [existing] = await db
      .select()
      .from(tripCollaborators)
      .where(and(eq(tripCollaborators.tripId, trip.id), eq(tripCollaborators.userId, userId)))
      .limit(1);

    // Never downgrade someone who is already on the trip.
    if (existing) {
      return NextResponse.json({
        tripId: trip.id,
        role: existing.role === 'owner' ? 'co-planner' : 'collaborator',
        alreadyMember: true,
      });
    }

    const [member] = await db
      .insert(tripCollaborators)
      .values({ tripId: trip.id, userId, role: invite.role })
      .returning();

    return NextResponse.json({
      tripId: trip.id,
      role: member.role === 'owner' ? 'co-planner' : 'collaborator',
      alreadyMember: false,
    });
  } catch (error) {
    console.error('Invite POST error:', error);
    return NextResponse.json({ error: 'Failed to join trip' }, { status: 500 });
  }
}
