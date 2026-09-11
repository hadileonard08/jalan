import 'dotenv/config';
import { db } from '../src/db';
import { geocodedLocations } from '../src/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  // Check what's in the DB cache for Seattle landmarks
  const allCached = await db.select().from(geocodedLocations);
  const seattleEntries = allCached.filter(e => e.queryKey.includes(':seattle'));
  console.log(`\n=== Seattle cached entries (${seattleEntries.length}) ===`);
  for (const e of seattleEntries) {
    console.log(`  ${e.queryKey} => lat=${e.lat}, lon=${e.lon}, display="${e.displayName?.slice(0, 80)}"`);
  }

  // Also check entries that DON'T have the city in display name (stale)
  console.log(`\n=== Potentially stale entries (display name doesn't match city) ===`);
  for (const e of allCached) {
    const city = e.queryKey.split(':')[1] || '';
    const display = (e.displayName || '').toLowerCase();
    if (city && !display.includes(city)) {
      console.log(`  ${e.queryKey} => lat=${e.lat}, lon=${e.lon}, display="${e.displayName?.slice(0, 80)}"`);
    }
  }

  // Test live geocoding for a few Seattle landmarks
  console.log('\n=== Live Nominatim test ===');
  const testPlaces = [
    'Pike Place Market',
    'Space Needle',
    'Chihuly Garden and Glass',
    'Museum of Pop Culture',
    'Original Starbucks',
  ];
  for (const place of testPlaces) {
    const query = encodeURIComponent(`${place}, Seattle`);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=3`,
      { headers: { 'User-Agent': 'flight-deal-dashboard/1.0 (test)' } }
    );
    const data = await res.json() as any[];
    console.log(`\n  "${place}, Seattle":`);
    for (const item of data.slice(0, 3)) {
      const display = item.display_name || '';
      const inSeattle = display.toLowerCase().includes('seattle');
      console.log(`    lat=${item.lat}, lon=${item.lon}, inSeattle=${inSeattle}, display="${display.slice(0, 80)}"`);
    }
  }
}

main().catch(console.error);
