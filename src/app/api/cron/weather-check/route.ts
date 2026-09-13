import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { savedTrips } from '@/db/schema';
import { getDepartureWeatherAlert } from '@/agents/weather';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const targetDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    const trips = await db
      .select({
        id: savedTrips.id,
        destination: savedTrips.destination,
        destinationCode: sql<string | null>`${savedTrips.payload}::jsonb #>> '{entities,destinationCode}'`,
        waypoints: sql<unknown>`${savedTrips.payload}::jsonb #> '{transportPlan,days,0,waypoints}'`,
        weatherAlert: savedTrips.weatherAlert,
      })
      .from(savedTrips)
      .where(sql`left(coalesce(nullif(${savedTrips.payload}::jsonb #>> '{entities,startDate}', ''), ${savedTrips.dates}), 10) = ${targetDate}`);

    const forecasts = new Map<string, Promise<string | null>>();
    let checked = 0;
    let alerts = 0;
    let failed = 0;

    for (let index = 0; index < trips.length; index += 5) {
      await Promise.all(trips.slice(index, index + 5).map(async (trip) => {
        try {
          const key = JSON.stringify([trip.destination, trip.destinationCode, trip.waypoints]);
          let forecast = forecasts.get(key);
          if (!forecast) {
            forecast = getDepartureWeatherAlert({
              destination: trip.destination,
              destinationCode: trip.destinationCode,
              departureDate: targetDate,
              waypoints: trip.waypoints,
            });
            forecasts.set(key, forecast);
          }
          const weatherAlert = await forecast;
          if (weatherAlert !== trip.weatherAlert) {
            await db.update(savedTrips).set({ weatherAlert }).where(eq(savedTrips.id, trip.id));
          }
          checked++;
          if (weatherAlert) alerts++;
        } catch {
          failed++;
          console.error('[Weather check] Could not update trip:', trip.id);
        }
      }));
    }

    return NextResponse.json(
      { success: failed === 0, targetDate, checked, alerts, failed },
      { status: failed > 0 ? 500 : 200 },
    );
  } catch {
    console.error('[Weather check] Could not load saved trips');
    return NextResponse.json({ error: 'Failed to check trip weather' }, { status: 500 });
  }
}
