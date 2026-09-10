import 'dotenv/config';
import { AIRPORT_NAMES } from '../src/lib/airports';

const SERVICE_URL = process.env.IMAGE_SEARCH_SERVICE_URL;

// Tuned to keep memory and Wikimedia rate limits sane.
const BATCH_SIZE = 16;
const PER_TERM = 5;
const TERM_VARIANTS = ['', 'skyline', 'landmark', 'night', 'beach'];
const SLEEP_MS = 200; // ~5 Wikimedia requests per second, polite.

interface Candidate {
  image_url: string;
  location_name: string;
}

function hasGoodDimensions(width?: number, height?: number): boolean {
  if (!width || !height) return true; // accept if unknown
  if (width < 200 || height < 150) return false;
  if (height > width * 2) return false;
  return true;
}

function isBadImageUrl(url: string): boolean {
  const BAD_IMAGE_PATTERNS = [
    /flag_of/i,
    /\/flag\//i,
    /_flag\./i,
    /emblem_of/i,
    /coat_of_arms/i,
    /_emblem\./i,
    /_logo/i,
    /logo_/i,
    /\/logo\//i,
    /_icon/i,
    /icon_/i,
    /_seal/i,
    /seal_of/i,
    /_map\./i,
    /\/map\//i,
    /_map_/i,
    /location_map/i,
    /relief_map/i,
    /topographic/i,
    /_diagram/i,
    /diagram_/i,
    /_chart/i,
    /_graph/i,
    /_infographic/i,
    /_sign\./i,
    /_plaque/i,
    /_statue_of/i,
    /text_document/i,
    /_blank\./i,
    /placeholder/i,
    /\.pdf(?:\.|$)/i,
    /\.svg$/i,
  ];
  return BAD_IMAGE_PATTERNS.some(pattern => pattern.test(url));
}

async function fetchWikimediaUrls(term: string, limit: number): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrnamespace=6&gsrlimit=${limit * 2}&prop=imageinfo&iiprop=url|thumb|size&iiurlwidth=800&format=json&origin=*`,
      {
        headers: { 'User-Agent': 'Jalan Image Search/1.0 (seed)' },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return [];

    const candidates: Candidate[] = [];
    for (const pageId in pages) {
      const page = pages[pageId];
      const info = page?.imageinfo?.[0];
      if (!info) continue;
      const url = info.thumburl || info.url;
      const width = info.thumbwidth || info.width;
      const height = info.thumbheight || info.height;
      if (!url || isBadImageUrl(url) || !hasGoodDimensions(width, height)) continue;
      candidates.push({ image_url: url, location_name: term });
      if (candidates.length >= limit) break;
    }
    return candidates;
  } catch (error) {
    console.error('Wikimedia search failed for', term, ':', (error as Error).message);
    return [];
  }
}

async function ingestBatch(batch: Candidate[]): Promise<{ ingested: number; failed: number }> {
  if (!SERVICE_URL) {
    throw new Error('IMAGE_SEARCH_SERVICE_URL is not set');
  }
  const res = await fetch(`${SERVICE_URL}/batch-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: batch }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Batch ingest failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { ingested: number; failed: number };
  return { ingested: data.ingested || 0, failed: data.failed || 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const limit = Number(process.argv[2]) || 1000;
  if (!SERVICE_URL) {
    console.error('IMAGE_SEARCH_SERVICE_URL must be set in your environment');
    process.exit(1);
  }

  // Unique city names from the airport lookup.
  const cities = Array.from(new Set(Object.values(AIRPORT_NAMES))).sort();
  console.log(`[seed] ${cities.length} unique destinations; target ${limit} images`);

  const seen = new Set<string>();
  const queue: Candidate[] = [];

  for (const city of cities) {
    if (queue.length >= limit) break;

    const terms = TERM_VARIANTS
      .map(v => (v ? `${city} ${v}` : city).trim())
      .filter((t, i, arr) => arr.indexOf(t) === i); // dedupe variants

    for (const term of terms) {
      if (queue.length >= limit) break;
      const candidates = await fetchWikimediaUrls(term, Math.min(PER_TERM, limit - queue.length));
      for (const c of candidates) {
        if (seen.has(c.image_url)) continue;
        seen.add(c.image_url);
        queue.push(c);
        if (queue.length >= limit) break;
      }
      await sleep(SLEEP_MS);
    }
  }

  if (queue.length === 0) {
    console.log('[seed] no candidates found');
    return;
  }

  console.log(`[seed] ingesting ${queue.length} unique images in batches of ${BATCH_SIZE}`);
  let totalIngested = 0;
  let totalFailed = 0;

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    try {
      const result = await ingestBatch(batch);
      totalIngested += result.ingested;
      totalFailed += result.failed;
      process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: +${result.ingested} `);
      if (result.failed) process.stdout.write(`(-${result.failed} failed) `);
      process.stdout.write('\n');
    } catch (error) {
      console.error('\n[seed] batch failed:', (error as Error).message);
    }
  }

  console.log(`[seed] done — ingested ${totalIngested}, failed ${totalFailed}, target ${queue.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
