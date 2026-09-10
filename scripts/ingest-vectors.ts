import 'dotenv/config';
import { findImageForTerm } from '../src/agents/destination-images';

const SERVICE_URL = process.env.IMAGE_SEARCH_SERVICE_URL;

async function ingestImage(imageUrl: string, locationName: string): Promise<void> {
  if (!SERVICE_URL) {
    throw new Error('IMAGE_SEARCH_SERVICE_URL is not set');
  }
  const res = await fetch(`${SERVICE_URL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, location_name: locationName }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed for "${locationName}": ${res.status} ${text}`);
  }
}

async function main() {
  const terms = process.argv.slice(2);
  if (terms.length === 0) {
    console.error('Usage: npx tsx scripts/ingest-vectors.ts <landmark1> <landmark2> ...');
    process.exit(1);
  }

  if (!SERVICE_URL) {
    console.error('IMAGE_SEARCH_SERVICE_URL must be set in your environment');
    process.exit(1);
  }

  for (const term of terms) {
    console.log(`[ingest] finding image for "${term}"...`);
    const url = await findImageForTerm(term, [], false);
    if (!url) {
      console.log(`[ingest] no image found for "${term}"`);
      continue;
    }
    console.log(`[ingest] found ${url}`);
    try {
      await ingestImage(url, term);
      console.log(`[ingest] stored "${term}"`);
    } catch (error) {
      console.error(`[ingest] failed "${term}": ${(error as Error).message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
