import 'dotenv/config';
import { db } from '../src/db';
import { geocodedLocations } from '../src/db/schema';
import { eq, not, like, or, and } from 'drizzle-orm';

async function main() {
  const allCached = await db.select().from(geocodedLocations);
  console.log(`Total cached entries: ${allCached.length}`);

  let deleted = 0;
  for (const entry of allCached) {
    const city = entry.queryKey.split(':')[1] || '';
    const display = (entry.displayName || '').toLowerCase();
    const cityLower = city.toLowerCase().split(',')[0].trim();

    // Delete if display name doesn't contain the city (stale from old fallback)
    if (cityLower && !display.includes(cityLower)) {
      await db.delete(geocodedLocations).where(eq(geocodedLocations.queryKey, entry.queryKey));
      console.log(`  DELETED: ${entry.queryKey} => ${entry.displayName?.slice(0, 60)}`);
      deleted++;
      continue;
    }

    // Delete time-slot heading entries (🌅 Morning:, 🌞 Afternoon:, 🌙 Evening:)
    const place = entry.queryKey.split(':')[0];
    if (/^(?:[🌅🌞🌙]\s*)?(?:morning|afternoon|evening)\s*:?\s*$/i.test(place)) {
      await db.delete(geocodedLocations).where(eq(geocodedLocations.queryKey, entry.queryKey));
      console.log(`  DELETED (time-slot heading): ${entry.queryKey}`);
      deleted++;
    }
  }

  console.log(`\nDeleted ${deleted} stale/invalid cache entries.`);

  // Show remaining Seattle entries
  const remaining = await db.select().from(geocodedLocations);
  const seattleRemaining = remaining.filter(e => e.queryKey.includes(':seattle'));
  console.log(`\nRemaining Seattle entries (${seattleRemaining.length}):`);
  for (const e of seattleRemaining) {
    console.log(`  ${e.queryKey} => lat=${e.lat}, lon=${e.lon}`);
  }
}

main().catch(console.error);
