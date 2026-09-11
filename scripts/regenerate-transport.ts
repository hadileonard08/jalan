import 'dotenv/config';
import { db } from '../src/db';
import { savedTrips } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { buildTransportPlan } from '../src/agents/transport';
import { buildRouteLinks } from '../src/agents/itinerary-guardrails';

async function main() {
  const trips = await db.select().from(savedTrips);
  const seattleTrips = trips.filter(t => t.destination.toLowerCase().includes('seattle'));

  for (const trip of seattleTrips) {
    console.log(`\n=== Regenerating: ${trip.destination} (${trip.dates}) ===`);
    const payload = JSON.parse(trip.payload);

    // Rebuild route links from the itinerary text (filters time-slot headings now).
    const newRouteLinks = buildRouteLinks(payload.itinerary || '', trip.destination);
    console.log(`Old route links: ${payload.routeLinks?.length || 0}, new: ${newRouteLinks.length}`);
    for (const rl of newRouteLinks) {
      console.log(`  Day ${rl.day}: ${rl.highlights}`);
    }

    // Rebuild transport plan from the new route links.
    const newTransport = await buildTransportPlan(newRouteLinks, trip.destination, payload.itinerary);
    if (newTransport) {
      for (const day of newTransport.days) {
        console.log(`  Day ${day.day} waypoints:`);
        for (const wp of (day.waypoints || [])) {
          const inSeattle = wp.lat > 47.5 && wp.lat < 47.75 && wp.lon > -122.45 && wp.lon < -122.25;
          console.log(`    ${wp.order}. ${wp.name} => ${wp.lat}, ${wp.lon} ${inSeattle ? '' : ' <-- OUTSIDE SEATTLE'}`);
        }
      }
    }

    // Update the payload.
    payload.routeLinks = newRouteLinks;
    payload.transportPlan = newTransport;

    await db.update(savedTrips)
      .set({ payload: JSON.stringify(payload), updatedAt: new Date() })
      .where(eq(savedTrips.id, trip.id));

    console.log(`  Updated saved trip ${trip.id}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
