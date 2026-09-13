import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { savedTrips } from '@/db/schema';
import { getDepartureWeatherAlert, getDestinationWeatherSnapshot } from '@/agents/weather';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_SIZE = 5;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const targetDate = new Date(nowMs + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try {
    // 1. Alerts — trips departing exactly two calendar days out.
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

    for (let index = 0; index < trips.length; index += BATCH_SIZE) {
      await Promise.all(trips.slice(index, index + BATCH_SIZE).map(async (trip) => {
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

    // 2. Snapshots — live destination forecast powering the One Stop Weather
    // tab. Deduped by destination so each place is fetched once per run.
    const allTrips = await db
      .select({
        destination: savedTrips.destination,
        destinationCode: sql<string | null>`${savedTrips.payload}::jsonb #>> '{entities,destinationCode}'`,
        waypoints: sql<unknown>`${savedTrips.payload}::jsonb #> '{transportPlan,days,0,waypoints}'`,
        startDate: sql<string | null>`${savedTrips.payload}::jsonb #>> '{entities,startDate}'`,
      })
      .from(savedTrips);

    const destinations = new Map<string, (typeof allTrips)[number]>();
    for (const trip of allTrips) {
      const isPast = !!trip.startDate && /^\d{4}-\d{2}-\d{2}$/.test(trip.startDate) && trip.startDate < today;
      if (isPast) continue;
      const key = `${trip.destination}|${trip.destinationCode}|${JSON.stringify(trip.waypoints)}`;
      if (!destinations.has(key)) destinations.set(key, trip);
    }

    let snapshots = 0;
    let snapshotFailures = 0;
    const targets = [...destinations.values()];

    for (let index = 0; index < targets.length; index += BATCH_SIZE) {
      await Promise.all(targets.slice(index, index + BATCH_SIZE).map(async (trip) => {
        try {
          const snapshot = await getDestinationWeatherSnapshot({
            destination: trip.destination,
            destinationCode: trip.destinationCode,
            waypoints: trip.waypoints,
          });
          await db
            .update(savedTrips)
            .set({ weatherSnapshot: JSON.stringify(snapshot), weatherUpdatedAt: new Date(nowMs) })
            .where(eq(savedTrips.destination, trip.destination));
          snapshots++;
        } catch {
          snapshotFailures++;
          console.error('[Weather check] Could not refresh snapshot for:', trip.destination);
        }
      }));
    }

    // 3. Drop alerts left over from trips that already departed.
    await db
      .update(savedTrips)
      .set({ weatherAlert: null })
      .where(sql`${savedTrips.weatherAlert} is not null and left(coalesce(nullif(${savedTrips.payload}::jsonb #>> '{entities,startDate}', ''), ${savedTrips.dates}), 10) < ${today}`);

    const success = failed === 0 && snapshotFailures === 0;
    return NextResponse.json(
      { success, targetDate, checked, alerts, failed, snapshots, snapshotFailures },
      { status: success ? 200 : 500 },
    );
  } catch {
    console.error('[Weather check] Could not load saved trips');
    return NextResponse.json({ error: 'Failed to check trip weather' }, { status: 500 });
  }
}
