/**
 * Backfill: repair trips that were edited before the enrichment refresh existed.
 *
 * Approved edits used to patch only the itinerary text, leaving the day's hero
 * image, route link, map waypoints, and transport notes describing the old stop.
 * This finds those days and rebuilds them.
 *
 * Usage:
 *   npx tsx scripts/backfill-enrichment.ts --dry-run
 *   npx tsx scripts/backfill-enrichment.ts                # all trips
 *   npx tsx scripts/backfill-enrichment.ts Seattle        # one destination
 */

import 'dotenv/config';
import { db } from '../src/db';
import { savedTrips } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { refreshEnrichment, staleImageDays } from '../src/lib/refresh-enrichment';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const destinationFilter = args.find((a) => !a.startsWith('--'));

async function main() {
  const all = await db.select().from(savedTrips);
  const trips = destinationFilter
    ? all.filter((t) => t.destination.toLowerCase() === destinationFilter.toLowerCase())
    : all;

  if (trips.length === 0) {
    console.log('No matching saved trips.');
    return;
  }

  for (const trip of trips) {
    const payload = JSON.parse(trip.payload);
    // A day whose hero image names a stop that no longer exists was edited before
    // this refresh existed. Refreshing it rebuilds the image AND its map/routes.
    const days = staleImageDays(payload.itinerary || []).sort((a, b) => a - b);
    console.log(`\n${trip.destination}: days with a stale hero image -> [${days}]`);

    if (days.length === 0) {
      console.log('  nothing to repair');
      continue;
    }
    if (dryRun) {
      console.log(`  would refresh days ${days.join(', ')}`);
      continue;
    }

    const refreshed = await refreshEnrichment(payload, trip.destination, days.map((dayNumber) => ({ dayNumber })));

    await db
      .update(savedTrips)
      .set({ payload: JSON.stringify(refreshed), updatedAt: new Date() })
      .where(eq(savedTrips.id, trip.id));

    const day1 = (refreshed.itinerary || '').split(/(?=^#+\s+Day\s+\d+)/im)[1] || '';
    console.log('  repaired. Day 1 now:');
    console.log('    image   :', (day1.match(/!\[([^\]]+)\]/) || [])[1] || '(none)');
    const wp = (refreshed.transportPlan?.days || []).find((d: any) => d.day === '1');
    console.log('    map     :', (wp?.waypoints || []).map((w: any) => w.name).join(' → ') || '(none)');
    const rl = (refreshed.routeLinks || []).find((r: any) => r.day === '1');
    console.log('    gmaps   :', rl?.highlights || '(none)');
  }

  console.log(dryRun ? '\n(dry run — nothing written)' : '\nBackfill complete.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
