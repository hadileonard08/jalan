import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { userPreferences } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/user-preferences — fetch the current user's preferences.
export async function GET() {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ preferences: null });
    }

    const row = rows[0];
    return NextResponse.json({
      preferences: {
        userId: row.userId,
        dietaryRestrictions: row.dietaryRestrictions,
        transportPreference: row.transportPreference,
        airlinePreference: row.airlinePreference,
        generalNotes: row.generalNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('User preferences GET error:', error);
    return NextResponse.json({ error: 'Failed to load preferences' }, { status: 500 });
  }
}

// PATCH /api/user-preferences — upsert the current user's preferences.
export async function PATCH(req: NextRequest) {
  try {
    const userId = auth().userId;
    if (!userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await req.json();
    const { dietaryRestrictions, transportPreference, airlinePreference, generalNotes } = body;

    const values: any = { userId };
    if (dietaryRestrictions !== undefined) values.dietaryRestrictions = dietaryRestrictions || null;
    if (transportPreference !== undefined) values.transportPreference = transportPreference || null;
    if (airlinePreference !== undefined) values.airlinePreference = airlinePreference || null;
    if (generalNotes !== undefined) values.generalNotes = generalNotes || null;

    const [row] = await db
      .insert(userPreferences)
      .values(values)
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          dietaryRestrictions: values.dietaryRestrictions,
          transportPreference: values.transportPreference,
          airlinePreference: values.airlinePreference,
          generalNotes: values.generalNotes,
          updatedAt: new Date(),
        },
      })
      .returning();

    return NextResponse.json({
      preferences: {
        userId: row.userId,
        dietaryRestrictions: row.dietaryRestrictions,
        transportPreference: row.transportPreference,
        airlinePreference: row.airlinePreference,
        generalNotes: row.generalNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('User preferences PATCH error:', error);
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }
}
