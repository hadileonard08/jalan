import 'dotenv/config';
import { geocode } from '../src/agents/transport';
import { db } from '../src/db';
import { geocodedLocations } from '../src/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const queryKey = 'colosseum:rome';
  // Start with a clean cache so the first call is guaranteed to be an API request.
  const before = await db.select().from(geocodedLocations).where(eq(geocodedLocations.queryKey, queryKey));
  console.log(`  cache entries for "${queryKey}" before delete: ${before.length}`);
  await db.delete(geocodedLocations).where(eq(geocodedLocations.queryKey, queryKey));
  const after = await db.select().from(geocodedLocations).where(eq(geocodedLocations.queryKey, queryKey));
  console.log(`  cache entries for "${queryKey}" after delete: ${after.length}`);

  console.log('Geocoding "Colosseum" in Rome — first call should be a Nominatim request');
  const t0 = Date.now();
  const first = await geocode('Colosseum', 'Rome');
  const firstMs = Date.now() - t0;
  console.log(`  first call: ${firstMs}ms`, first);

  const afterFirst = await db.select().from(geocodedLocations).where(eq(geocodedLocations.queryKey, queryKey));
  console.log(`  cache entries after first call: ${afterFirst.length}`);

  console.log('Second call should hit the PostgreSQL cache');
  const t1 = Date.now();
  const second = await geocode('Colosseum', 'Rome');
  const secondMs = Date.now() - t1;
  console.log(`  second call: ${secondMs}ms`, second);

  if (!first || !second) {
    throw new Error('Geocoding returned null');
  }
  if (afterFirst.length !== 1) {
    throw new Error('First call did not persist the geocode result to the database');
  }
  if (firstMs < 100) {
    throw new Error(`First call was too fast (${firstMs}ms); expected a Nominatim API request`);
  }
  if (secondMs > 50) {
    throw new Error(`Second call was too slow (${secondMs}ms); expected a cache hit under 50ms`);
  }
  if (first.lat !== second.lat || first.lon !== second.lon) {
    throw new Error('Cache returned different coordinates');
  }

  console.log('\nPASS: Geocoding DB cache works correctly.');
}

main().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
