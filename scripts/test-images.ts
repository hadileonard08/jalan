/**
 * Local image quality test — does NOT call Gemini or any LLM.
 * Tests the image hydration pipeline directly against Wikimedia,
 * Wikipedia, Openverse, and Pexels for a list of landmarks.
 *
 * Usage:
 *   npx tsx scripts/test-images.ts
 *   npx tsx scripts/test-images.ts --landmarks "Emirates Stadium" "Senso-ji Temple"
 *   npx tsx scripts/test-images.ts --destination London
 *
 * No API keys needed (except Pexels if you want to test that source).
 * No Gemini tokens consumed. No server required.
 */

import { getImageForTerm, getDestinationImageUrl, hydrateItineraryImages, scoreImageRelevance } from '../src/agents/destination-images';

interface ImageResult {
  term: string;
  url: string | null;
  source: string;
  relevance: 'high' | 'medium' | 'low' | 'none';
}

// Default test landmarks — a mix of famous and tricky ones.
const DEFAULT_LANDMARKS = [
  // Famous landmarks (should always find good images)
  'Eiffel Tower',
  'Louvre Museum',
  'Senso-ji Temple',
  'Emirates Stadium',
  'Wembley Stadium',
  // Tricky ones (commonly return bad images)
  'Akihabara Electric Town',
  'Omoide Yokocho',
  'Nakamise Shopping Street',
  'Trocadéro Gardens',
  'Brick Lane Market',
  'Sindhu Night Market',
  // Stadiums (often confused with other things)
  'Camp Nou',
  'Allianz Arena',
  'San Siro',
  'Old Trafford',
];

const DEFAULT_DESTINATIONS = ['Tokyo', 'Paris', 'London', 'Madrid', 'Munich'];

function determineSource(url: string): string {
  if (url.includes('commons.wikimedia.org') || url.includes('upload.wikimedia.org/wikipedia/commons')) return 'Wikimedia Commons';
  if (url.includes('en.wikipedia.org') || url.includes('upload.wikimedia.org/wikipedia/en')) return 'Wikipedia';
  if (url.includes('openverse') || url.includes('flickr') || url.includes('rawpixel')) return 'Openverse';
  if (url.includes('pexels') || url.includes('images.pexels.com')) return 'Pexels';
  return 'Unknown';
}

function determineRelevance(url: string): 'high' | 'medium' | 'low' | 'none' {
  if (!url) return 'none';
  // Check for common bad patterns
  if (/flag|emblem|logo|icon|seal|map|diagram|chart|graph|infographic|\.pdf|\.svg/i.test(url)) return 'low';
  if (/placeholder|blank|text_document/i.test(url)) return 'none';
  return 'high';
}

async function testLandmarks(landmarks: string[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing ${landmarks.length} landmarks against image sources`);
  console.log(`${'='.repeat(70)}\n`);

  const results: ImageResult[] = [];
  let found = 0;
  let missed = 0;
  let lowQuality = 0;

  for (const term of landmarks) {
    process.stdout.write(`  ${term.padEnd(35)} `);
    const url = await getImageForTerm(term);
    if (url) {
      const source = determineSource(url);
      const relevance = determineRelevance(url);
      results.push({ term, url, source, relevance });
      if (relevance === 'low' || relevance === 'none') {
        lowQuality++;
        console.log(`⚠️  FOUND (low quality) [${source}]`);
        console.log(`     ${url.substring(0, 80)}...`);
      } else {
        found++;
        console.log(`✓ FOUND [${source}]`);
      }
    } else {
      missed++;
      results.push({ term, url: null, source: 'none', relevance: 'none' });
      console.log(`✗ NOT FOUND`);
    }
    // Small delay to be nice to the APIs
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${'-'.repeat(70)}`);
  console.log(`Summary: ${found} good, ${lowQuality} low quality, ${missed} not found (out of ${landmarks.length})`);
  console.log(`${'-'.repeat(70)}\n`);

  return results;
}

async function testDestinations(destinations: string[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing ${destinations.length} destination images`);
  console.log(`${'='.repeat(70)}\n`);

  for (const dest of destinations) {
    process.stdout.write(`  ${dest.padEnd(35)} `);
    const url = await getDestinationImageUrl('', dest);
    if (url) {
      const source = determineSource(url);
      const relevance = determineRelevance(url);
      if (relevance === 'low' || relevance === 'none') {
        console.log(`⚠️  FOUND (low quality) [${source}]`);
      } else {
        console.log(`✓ FOUND [${source}]`);
      }
      console.log(`     ${url.substring(0, 80)}...`);
    } else {
      console.log(`✗ NOT FOUND`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log();
}

async function testFullHydration() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing full itinerary image hydration`);
  console.log(`${'='.repeat(70)}\n`);

  const sampleItinerary = `# Tokyo Itinerary — 3 Days

## Day 1: Asakusa and Senso-ji
![IMAGE: Senso-ji Temple]

Start at **Senso-ji Temple**, Tokyo's oldest temple. Walk through **Nakamise Shopping Street**.

## Day 2: Shibuya and Harajuku
![IMAGE: Shibuya Crossing]

Experience the famous **Shibuya Crossing**. Explore **Takeshita Street** in Harajuku.

## Day 3: Akihabara and Ueno
![IMAGE: Akihabara Electric Town]

Dive into anime culture at **Akihabara Electric Town**. Visit **Ueno Park**.
`;

  const hydrated = await hydrateItineraryImages(sampleItinerary, 'Tokyo');
  console.log(hydrated);
  console.log(`\n${'-'.repeat(70)}\n`);
}

async function main() {
  const badSindhuScore = scoreImageRelevance(
    { title: 'The British Empire in the nineteenth century, its progress and expansion', tags: [] },
    'Sindhu Night Market',
  );
  if (badSindhuScore !== 0) {
    throw new Error(`Unrelated Sindhu candidate scored ${badSindhuScore}; expected 0`);
  }

  const args = process.argv.slice(2);

  // Parse args
  const landmarksIdx = args.indexOf('--landmarks');
  const destIdx = args.indexOf('--destination');
  const fullIdx = args.indexOf('--full');

  if (landmarksIdx !== -1) {
    // Test specific landmarks
    const landmarks = args.slice(landmarksIdx + 1).filter(a => !a.startsWith('--'));
    await testLandmarks(landmarks);
  } else if (destIdx !== -1) {
    // Test specific destination
    const dest = args[destIdx + 1];
    if (dest) await testDestinations([dest]);
  } else if (fullIdx !== -1) {
    // Full hydration test only
    await testFullHydration();
  } else {
    // Default: run all tests
    await testLandmarks(DEFAULT_LANDMARKS);
    await testDestinations(DEFAULT_DESTINATIONS);
    await testFullHydration();
  }
}

main().catch(console.error);
