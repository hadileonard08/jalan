import 'dotenv/config';
import { AIRPORT_NAMES } from '../src/lib/airports';

const SERVICE_URL = process.env.IMAGE_SEARCH_SERVICE_URL;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// Tuned to keep memory and per-provider rate limits sane while maximizing diversity.
const BATCH_SIZE = 16;
const PER_SOURCE = 5; // small cap per term/source — no single landmark hogs the DB
const SLEEP_MS = 80; // small pause between search terms

// Diverse search variants per destination. This spreads the corpus across cityscapes,
// landmarks, food markets, nature, and architecture instead of one bucket per city.
const TERM_VARIANTS = [
  '',
  'skyline',
  'landmark',
  'temple',
  'market',
  'night',
  'beach',
  'park',
  'street',
  'bridge',
  'palace',
  'garden',
];

interface Candidate {
  image_url: string;
  location_name: string;
}

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

function hasGoodDimensions(width?: number, height?: number): boolean {
  if (!width || !height) return true; // accept if unknown
  if (width < 200 || height < 150) return false;
  if (height > width * 2) return false;
  return true;
}

function isBadImageUrl(url: string): boolean {
  return BAD_IMAGE_PATTERNS.some(pattern => pattern.test(url));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchExistingUrls(): Promise<Set<string>> {
  if (!SERVICE_URL) return new Set();
  try {
    const res = await fetch(`${SERVICE_URL}/images`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as string[];
    return new Set(data);
  } catch {
    return new Set();
  }
}

async function fetchWikimediaUrls(term: string, limit: number): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrnamespace=6&gsrlimit=${Math.min(limit * 2, 50)}&prop=imageinfo&iiprop=url|thumb|size&iiurlwidth=800&format=json&origin=*`,
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

async function fetchOpenverseUrls(term: string, limit: number): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(term)}&page_size=${Math.min(limit * 2, 20)}`,
      {
        headers: { 'User-Agent': 'Jalan Image Search/1.0 (seed)' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!data?.results || data.results.length === 0) return [];

    const candidates: Candidate[] = [];
    for (const result of data.results) {
      const url = result.url || result.thumbnail;
      const width = result.width;
      const height = result.height;
      if (!url || isBadImageUrl(url) || !hasGoodDimensions(width, height)) continue;
      candidates.push({ image_url: url, location_name: term });
      if (candidates.length >= limit) break;
    }
    return candidates;
  } catch (error) {
    console.error('Openverse search failed for', term, ':', (error as Error).message);
    return [];
  }
}

async function fetchPexelsUrls(term: string, limit: number): Promise<Candidate[]> {
  if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('your_pexels_api_key')) return [];
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(term)}&per_page=${Math.min(limit * 2, 15)}&orientation=landscape`,
      {
        headers: { Authorization: PEXELS_API_KEY },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!data?.photos || data.photos.length === 0) return [];

    const candidates: Candidate[] = [];
    for (const photo of data.photos) {
      const url = photo.src?.large || photo.src?.medium || photo.src?.small || photo.src?.original;
      const width = photo.width;
      const height = photo.height;
      if (!url || isBadImageUrl(url) || !hasGoodDimensions(width, height)) continue;
      candidates.push({ image_url: url, location_name: term });
      if (candidates.length >= limit) break;
    }
    return candidates;
  } catch (error) {
    console.error('Pexels search failed for', term, ':', (error as Error).message);
    return [];
  }
}

async function fetchAllUrls(term: string, limit: number): Promise<Candidate[]> {
  // Start with the fastest, most reliable source (Wikimedia Commons).
  const candidates = await fetchWikimediaUrls(term, limit);

  // Only hit slow third-party sources when Wikimedia has nothing usable.
  // This keeps the seed fast while preserving diversity.
  if (candidates.length === 0) {
    const openverse = await fetchOpenverseUrls(term, limit);
    candidates.push(...openverse);
    if (candidates.length === 0 && PEXELS_API_KEY) {
      const pexels = await fetchPexelsUrls(term, limit);
      candidates.push(...pexels);
    }
  }

  return candidates.slice(0, limit);
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

async function main() {
  const limit = Number(process.argv[2]) || 1000;
  if (!SERVICE_URL) {
    console.error('IMAGE_SEARCH_SERVICE_URL must be set in your environment');
    process.exit(1);
  }

  const existing = await fetchExistingUrls();
  console.log(`[seed] ${existing.size} images already in vector DB`);

  const cities = Array.from(new Set(Object.values(AIRPORT_NAMES))).sort();
  console.log(`[seed] ${cities.length} unique destinations; target ${limit} images`);

  const seen = new Set(existing);
  const queue: Candidate[] = [];

  for (const city of cities) {
    if (queue.length >= limit) break;
    for (const variant of TERM_VARIANTS) {
      if (queue.length >= limit) break;
      const term = variant ? `${city} ${variant}` : city;
      const candidates = await fetchAllUrls(term, PER_SOURCE);
      for (const c of candidates) {
        if (seen.has(c.image_url)) continue;
        seen.add(c.image_url);
        queue.push(c);
        if (queue.length >= limit) break;
      }
      process.stdout.write(`\r[seed] collected ${queue.length}/${limit} candidates`);
      await sleep(SLEEP_MS);
    }
  }

  process.stdout.write('\n');
  if (queue.length === 0) {
    console.log('[seed] no new candidates found');
    return;
  }

  console.log(`[seed] ingesting ${queue.length} unique new images in batches of ${BATCH_SIZE}`);
  let totalIngested = 0;
  let totalFailed = 0;

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    try {
      const result = await ingestBatch(batch);
      totalIngested += result.ingested;
      totalFailed += result.failed;
      const progress = `batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(queue.length / BATCH_SIZE)}: +${result.ingested}`;
      console.log(`  ${progress}` + (result.failed ? ` (-${result.failed} failed)` : ''));
    } catch (error) {
      console.error('\n[seed] batch failed:', (error as Error).message);
    }
  }

  console.log(`[seed] done — ingested ${totalIngested}, failed ${totalFailed}, queued ${queue.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
