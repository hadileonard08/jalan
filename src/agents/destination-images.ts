import { AIRPORT_NAMES } from '../lib/airports';
import { stemmer } from 'stemmer';

const WIKIPEDIA_CITIES: Record<string, string> = {
  // Asia
  HND: 'Tokyo',
  NRT: 'Tokyo',
  KIX: 'Osaka',
  HKG: 'Hong Kong',
  ICN: 'Seoul',
  SIN: 'Singapore',
  BKK: 'Bangkok',
  CNX: 'Chiang Mai',
  TPE: 'Taipei',
  KUL: 'Kuala Lumpur',
  MNL: 'Manila',
  SGN: 'Ho Chi Minh City',
  HAN: 'Hanoi',
  DPS: 'Bali',
  CGK: 'Jakarta',
  BOM: 'Mumbai',
  DEL: 'New Delhi',
  PUS: 'Busan',
  // Europe
  LHR: 'London',
  LGW: 'London',
  CDG: 'Paris',
  ORY: 'Paris',
  FRA: 'Frankfurt',
  AMS: 'Amsterdam',
  MAD: 'Madrid',
  BCN: 'Barcelona',
  FCO: 'Rome',
  MXP: 'Milan',
  MUC: 'Munich',
  ZRH: 'Zurich',
  GVA: 'Geneva',
  VIE: 'Vienna',
  DUB: 'Dublin',
  LIS: 'Lisbon',
  ATH: 'Athens',
  PRG: 'Prague',
  WAW: 'Warsaw',
  CPH: 'Copenhagen',
  ARN: 'Stockholm',
  OSL: 'Oslo',
  HEL: 'Helsinki',
  IST: 'Istanbul',
  // Middle East
  DXB: 'Dubai',
  AUH: 'Abu Dhabi',
  DOH: 'Doha',
  TLV: 'Tel Aviv',
  // Latin America
  MEX: 'Mexico City',
  CUN: 'Cancun',
  BOG: 'Bogota',
  LIM: 'Lima',
  SCL: 'Santiago',
  EZE: 'Buenos Aires',
  GRU: 'Sao Paulo',
  GIG: 'Rio de Janeiro',
  // Oceania
  SYD: 'Sydney',
  MEL: 'Melbourne',
  BNE: 'Brisbane',
  AKL: 'Auckland',
  NAN: 'Nadi',
  // Africa
  JNB: 'Johannesburg',
  CPT: 'Cape Town',
  NBO: 'Nairobi',
  CMN: 'Casablanca',
};

const FLAG_PATTERNS = [
  /flag_of/i,
  /\/flag\//i,
  /_flag\./i,
  /emblem_of/i,
  /coat_of_arms/i,
  /_emblem\./i
];

// Patterns for images that are NOT photos of the landmark — maps, diagrams,
// logos, icons, seals, signs, etc. These pollute search results.
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
  /_statue_of/i,  // often returns a statue OF someone, not the landmark
  /text_document/i,
  /_blank\./i,
  /placeholder/i,
  /\.pdf(?:\.|$)/i,
  /\.svg$/i,  // SVGs are usually icons/diagrams, not photos
];

// Minimum relevance score (0-1) for accepting an image. Images below this
// threshold are likely not photos of the searched landmark.
const MIN_RELEVANCE_SCORE = 0.5;
const FETCH_TIMEOUT_MS = 5000;
const VECTOR_IMAGE_SERVICE_URL = process.env.IMAGE_SEARCH_SERVICE_URL;
const VECTOR_IMAGE_MIN_SCORE = parseFloat(process.env.VECTOR_IMAGE_MIN_SCORE || '0.15');
const RANK_TIMEOUT_MS = 30000; // downloading + encoding several images takes longer
const RANK_MIN_SCORE = parseFloat(process.env.VECTOR_IMAGE_MIN_SCORE || '0.22');
const RANK_CANDIDATES_PER_PROVIDER = 3;
const RANK_MAX_CANDIDATES = 9;
const imageSearchCache = new Map<string, Promise<string | null>>();

interface ImageCandidate {
  url: string;
  score: number;
  title?: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface ImageMetadata {
  title: string;
  tags: string[];
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function isBadImageUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  return BAD_IMAGE_PATTERNS.some(pattern => pattern.test(url));
}

const CULTURAL_LANDMARKS = new Set(['shrine', 'temple', 'palace', 'garden', 'cathedral', 'mosque', 'church', 'castle', 'monastery', 'chapel']);
const SPORTS_VENUE_WORDS = ['stadium', 'baseball', 'arena', 'ballpark', 'pitch', 'soccer', 'football', 'basketball', 'rugby', 'cricket', 'tennis'];

function hasMismatchWord(title: string, url: string, term: string): boolean {
  const termWords = new Set(term.toLowerCase().split(/\s+/).filter(Boolean));
  if (![...termWords].some((w) => CULTURAL_LANDMARKS.has(w))) return false;
  const text = `${title} ${url}`.toLowerCase();
  return SPORTS_VENUE_WORDS.some((w) => text.includes(w) && !termWords.has(w));
}

/**
 * Check whether the image URL/filename plausibly relates to the search term.
 * If the URL path contains none of the distinctive words from the term,
 * the image is likely a mismatch (e.g. a Tamsui harbor photo for a
 * Bali monkey forest search).
 */
function urlMatchesTerm(url: string, term: string): boolean {
  if (hasMismatchWord('', url, term)) return false;
  // Normalize both URL and term: strip punctuation to plain words
  const normalize = (s: string) => decodeURIComponent(s).toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const decoded = normalize(url);
  const termWords = normalize(term)
    .split(/\s+/)
    .filter(w => w.length >= 4)
    // Skip generic words that appear in many unrelated URLs
    .filter(w => !['beach', 'temple', 'forest', 'park', 'museum', 'market',
                    'photo', 'image', 'file', 'thumb', 'landmark', 'city',
                    'night', 'street', 'garden', 'sacred', 'national'].includes(w));
  // If there are no distinctive words, can't filter — accept
  if (termWords.length === 0) return true;
  // At least one distinctive word must appear in the URL
  return termWords.some(w => decoded.includes(w));
}

// Keep the old function name for backward compatibility.
function isFlagUrl(url: string | null | undefined): boolean {
  return isBadImageUrl(url);
}

export async function getDestinationImageUrl(destinationCode: string, destinationName?: string): Promise<string | null> {
  const city = WIKIPEDIA_CITIES[destinationCode] || destinationName || AIRPORT_NAMES[destinationCode] || destinationCode;
  if (!city) return null;

  // Prefer a cityscape / skyline image over a flag or coat of arms.
  const cityscapeUrl = await getImageForTerm(`${city} skyline`, [`${city} cityscape`, `${city} city`]);
  if (cityscapeUrl && !isBadImageUrl(cityscapeUrl)) return cityscapeUrl;

  const cityUrl = await getImageForTerm(city, [`${city} city`, `${city} landmark`]);
  if (cityUrl && !isBadImageUrl(cityUrl)) return cityUrl;

  return null;
}

function cleanTerm(term: string): string {
  return term
    .replace(/\[|\]/g, '')
    .replace(/^IMAGE:\s*/i, '')
    .trim();
}

export function scoreImageRelevance(image: ImageMetadata, term: string, originalRankIndex = 0): number {
  if (hasMismatchWord(`${image.title} ${image.tags.join(' ')}`, '', term)) return 0;
  const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ');
  const candidateWords = [...new Set(normalize(`${image.title} ${image.tags.join(' ')}`).split(/\s+/).filter(Boolean))];
  const termWords = normalize(term).split(/\s+/).filter(w => w.length > 2);
  if (termWords.length === 0) return 0;
  const genericWords = new Set([
    'building', 'city', 'cityscape', 'district', 'garden', 'landmark', 'market',
    'museum', 'night', 'palace', 'park', 'photo', 'shopping', 'skyline', 'station',
    'street', 'temple', 'tower',
  ]);
  const matchedWords = termWords.filter((word) => {
    const stemmedWord = stemmer(word);
    return candidateWords.some((candidateWord) => {
      const stemmedCandidate = stemmer(candidateWord);
      if (stemmedCandidate === stemmedWord) return true;
      if (word.length >= 5 && candidateWord.includes(word)) return true;
      if (word.length >= 5 && word.includes(candidateWord) && candidateWord.length >= 5) return true;
      const distance = levenshtein(stemmedWord, stemmedCandidate);
      return distance <= 2 && distance / Math.max(stemmedWord.length, stemmedCandidate.length) <= 0.25;
    });
  });
  const distinctiveWords = termWords.filter((word) => !genericWords.has(word));
  if (distinctiveWords.length > 0 && !matchedWords.some((word) => distinctiveWords.includes(word))) return 0;
  if (matchedWords.length === 0) return 0;
  let score = matchedWords.length / termWords.length;
  score += (20 - Math.min(originalRankIndex, 20)) * 0.015;
  const personTags = ['person', 'portrait', 'woman', 'man', 'selfie', 'face'];
  if (image.tags.some((tag) => personTags.includes(tag.toLowerCase().trim()))) {
    score *= 0.5;
  }
  return score;
}

// Check if an image URL looks like a real photo based on its dimensions
// (if available from the API response). Rejects tiny images, icons, and
// extremely tall/narrow images that are likely diagrams or signs.
function hasGoodDimensions(width?: number, height?: number): boolean {
  if (!width || !height) return true; // If dimensions unknown, don't reject.
  if (width < 200 || height < 150) return false;  // Too small.
  if (height > width * 2) return false;  // Very tall — likely a sign/banner.
  return true;
}

function expandImageTerm(term: string): string[] {
  const variants: string[] = [];
  const base = term.trim();
  if (!base) return variants;

  // Keep it lean: the base term, a stripped version, and a photo variant.
  // More variants = more API calls with diminishing returns.
  variants.push(base);

  // Strip generic suffixes and try the shorter name (e.g. "Senso-ji Temple" -> "Senso-ji").
  const stripped = base.replace(/\s+(Temple|Palace|Garden|Park|Castle|National Garden|National Park|Shrine|Building)$/i, '').trim();
  if (stripped && stripped !== base) {
    variants.push(stripped);
  }

  // One photo variant as a fallback — usually finds stock-like images
  variants.push(`${base} photo`);

  return [...new Set(variants)];
}

async function fetchWikimediaCommonsImages(term: string, maxResults = RANK_CANDIDATES_PER_PROVIDER): Promise<ImageCandidate[]> {
  try {
    const headers = { 'User-Agent': 'flight-deal-dashboard/1.0 (image lookup)' };
    const searchRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|thumb|size&iiurlwidth=800&format=json&origin=*`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!searchRes.ok) return [];
    const data = (await searchRes.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return [];

    const candidates: ImageCandidate[] = [];

    let rankIndex = 0;
    for (const pageId in pages) {
      const page = pages[pageId];
      const imageinfo = page?.imageinfo;
      const title = page?.title;
      if (imageinfo && imageinfo.length > 0) {
        const url = imageinfo[0].thumburl || imageinfo[0].url;
        const width = imageinfo[0]?.thumbwidth || imageinfo[0]?.width;
        const height = imageinfo[0]?.thumbheight || imageinfo[0]?.height;
        if (url && !isBadImageUrl(url) && hasGoodDimensions(width, height)) {
          const score = scoreImageRelevance({ title: title || '', tags: [] }, term, rankIndex);
          candidates.push({ url, title: title || '', score, width, height });
        }
      }
      rankIndex++;
    }

    if (candidates.length === 0) return [];

    // Sort by relevance score, then prefer landscape orientation.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aLandscape = (a.width || 0) > (a.height || 0) ? 1 : 0;
      const bLandscape = (b.width || 0) > (b.height || 0) ? 1 : 0;
      return bLandscape - aLandscape;
    });

    return candidates.slice(0, maxResults);
  } catch (error) {
    console.log('Wikimedia Commons image lookup failed for', term, ':', (error as Error).message);
    return [];
  }
}

export async function getImageForTerm(term: string, fallbackTerms: string[] = []): Promise<string | null> {
  const cacheKey = JSON.stringify([term.toLowerCase(), fallbackTerms.map((item) => item.toLowerCase())]);
  const cached = imageSearchCache.get(cacheKey);
  if (cached) return cached;
  const lookup = findImageForTerm(term, fallbackTerms);
  imageSearchCache.set(cacheKey, lookup);
  return lookup;
}

async function rankImagesWithVector(term: string, candidates: ImageCandidate[]): Promise<string | null> {
  if (!VECTOR_IMAGE_SERVICE_URL || candidates.length === 0) return null;
  try {
    const urls = candidates.slice(0, RANK_MAX_CANDIDATES).map(c => c.url);
    const res = await fetch(`${VECTOR_IMAGE_SERVICE_URL}/rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_term: term, image_urls: urls, limit: 1 }),
      signal: AbortSignal.timeout(RANK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image_url: string; similarity_score: number }[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const best = data[0];
    if (best.similarity_score >= RANK_MIN_SCORE && !isBadImageUrl(best.image_url)) {
      return best.image_url;
    }
    return null;
  } catch (error) {
    console.log('Vector image ranking failed for', term, ':', (error as Error).message);
    return null;
  }
}

/**
 * Collect candidate images from all providers, then use CLIP to rank them by
 * visual/semantic similarity to the search term. Falls back to lexical scoring
 * if the vector service is unavailable or no candidate reaches the threshold.
 */
async function collectAndRankImages(searchTerm: string, useVector = true): Promise<string | null> {
  const results = await Promise.allSettled([
    fetchWikimediaCommonsImages(searchTerm),
    fetchOpenverseImages(searchTerm),
    fetchPexelsImages(searchTerm),
  ]);

  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      for (const c of result.value) {
        if (!isBadImageUrl(c.url) && hasGoodDimensions(c.width, c.height) && !seen.has(c.url)) {
          seen.add(c.url);
          candidates.push(c);
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Prefer CLIP visual ranking when available.
  if (useVector && VECTOR_IMAGE_SERVICE_URL) {
    const rankedUrl = await rankImagesWithVector(searchTerm, candidates);
    if (rankedUrl) return rankedUrl;
  }

  // Fallback: lexical scoring + URL cross-check.
  const accepted = candidates
    .filter(c => urlMatchesTerm(c.url, searchTerm) && c.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score);
  if (accepted.length > 0) return accepted[0].url;

  // Last resort: even a marginal candidate is better than nothing if it's not a bad URL.
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates.find(c => !isBadImageUrl(c.url));
  return best?.url || null;
}

function locationMatchesTerm(location: string, term: string): boolean {
  if (!location || !term) return false;
  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ');
  const termWords = normalize(term).split(/\s+/).filter(Boolean).filter(w => w.length >= 4);
  const locationWords = normalize(location).split(/\s+/).filter(Boolean).filter(w => w.length >= 4);

  const genericWords = new Set([
    'city', 'skyline', 'landmark', 'temple', 'market', 'night', 'beach',
    'park', 'street', 'bridge', 'palace', 'garden', 'building', 'museum',
  ]);

  // Require at least one distinctive (non-generic) word from the query to appear
  // in the stored location_name. This prevents generic matches like a random
  // "temple" in Busan from satisfying "Senso-ji Temple".
  const distinctive = termWords.filter(w => !genericWords.has(w));
  if (distinctive.length > 0) {
    return distinctive.some(w => locationWords.includes(w));
  }

  // If the whole term is generic (e.g. "Tokyo skyline"), any shared generic word is fine.
  return termWords.some(w => locationWords.includes(w));
}

async function getVectorImage(term: string): Promise<string | null> {
  if (!VECTOR_IMAGE_SERVICE_URL) return null;
  try {
    const res = await fetch(`${VECTOR_IMAGE_SERVICE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_term: term, limit: 3 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    if (!Array.isArray(data) || data.length === 0) return null;
    for (const result of data) {
      const url = result?.image_url;
      const location = result?.location_name;
      const score = Number(result?.similarity_score);
      if (!url || Number.isNaN(score) || score < VECTOR_IMAGE_MIN_SCORE) continue;
      if (isBadImageUrl(url)) continue;
      if (!locationMatchesTerm(location, term)) continue;
      return url;
    }
    return null;
  } catch (error) {
    console.log('Vector image search failed for', term, ':', (error as Error).message);
    return null;
  }
}

export async function findImageForTerm(
  term: string,
  fallbackTerms: string[] = [],
  useVector = true
): Promise<string | null> {
  if (!term) return null;

  const cleaned = cleanTerm(term);
  if (!cleaned) return null;

  if (useVector && VECTOR_IMAGE_SERVICE_URL) {
    const vectorUrl = await getVectorImage(cleaned);
    if (vectorUrl) return vectorUrl;
  }

  const knownAliases: Record<string, string[]> = {
    'sindhu night market': ['Pasar Sindhu Sanur Bali', 'Sanur Bali night market street food', 'Bali traditional food market'],
  };
  const termsToTry = expandImageTerm(cleaned);
  const aliases = knownAliases[cleaned.toLowerCase()] || [];

  // Try each term variant, collecting candidates from all providers and ranking
  // them with CLIP when the vector service is configured.
  for (const t of [...termsToTry, ...aliases, ...fallbackTerms]) {
    const cleanedT = cleanTerm(t);
    if (!cleanedT) continue;

    const url = await collectAndRankImages(cleanedT, useVector);
    if (url) return url;
  }

  return null;
}

// Source 3: Openverse — free Creative Commons image search (no API key required).
// Searches millions of CC-licensed images from Flickr, Wikimedia, etc.
async function fetchOpenverseImages(term: string, maxResults = RANK_CANDIDATES_PER_PROVIDER): Promise<ImageCandidate[]> {
  try {
    const res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(term)}&page_size=12`,
      {
        headers: { 'User-Agent': 'flight-deal-dashboard/1.0 (image lookup)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!data?.results || data.results.length === 0) return [];

    const candidates: ImageCandidate[] = [];

    for (let rankIndex = 0; rankIndex < data.results.length; rankIndex++) {
      const result = data.results[rankIndex];
      const url = result.url;
      const thumb = result.thumbnail;
      const title = result.title || '';
      const width = result.width;
      const height = result.height;
      const tags = Array.isArray(result.tags)
        ? result.tags.map((t: any) => (typeof t === 'string' ? t : t?.name || '')).filter(Boolean)
        : [];

      const candidateUrl = url && !isBadImageUrl(url) ? url : (thumb && !isBadImageUrl(thumb) ? thumb : null);
      if (!candidateUrl) continue;
      if (!hasGoodDimensions(width, height)) continue;

      const score = scoreImageRelevance({ title, tags }, term, rankIndex);
      candidates.push({ url: candidateUrl, title, score, width, height });
    }

    if (candidates.length === 0) return [];

    // Sort by relevance, then prefer landscape.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aLandscape = (a.width || 0) > (a.height || 0) ? 1 : 0;
      const bLandscape = (b.width || 0) > (b.height || 0) ? 1 : 0;
      return bLandscape - aLandscape;
    });

    return candidates.slice(0, maxResults);
  } catch (error) {
    console.log('Openverse image lookup failed for', term, ':', (error as Error).message);
    return [];
  }
}

// Source 4: Pexels — free stock photos (requires PEXELS_API_KEY).
async function fetchPexelsImages(term: string, maxResults = RANK_CANDIDATES_PER_PROVIDER): Promise<ImageCandidate[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || apiKey.includes('your_pexels_api_key')) return [];

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(term)}&per_page=12&orientation=landscape`,
      {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!data?.photos || data.photos.length === 0) return [];

    const candidates: ImageCandidate[] = [];

    for (let rankIndex = 0; rankIndex < data.photos.length; rankIndex++) {
      const photo = data.photos[rankIndex];
      const url = photo.src?.large || photo.src?.medium || photo.src?.small || photo.src?.original;
      const alt = photo.alt || '';
      const width = photo.width;
      const height = photo.height;
      if (url && !isBadImageUrl(url) && hasGoodDimensions(width, height)) {
        const score = scoreImageRelevance({ title: alt, tags: [] }, term, rankIndex);
        candidates.push({ url, alt, score, width, height });
      }
    }

    if (candidates.length === 0) return [];

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxResults);
  } catch (error) {
    console.log('Pexels image lookup failed for', term, ':', (error as Error).message);
    return [];
  }
}

/**
 * Ensures every day heading in the itinerary has an image placeholder.
 * If the LLM forgot to include ![IMAGE: ...] for some days, this function
 * inserts one using the first bold landmark name found in that day's block.
 * If no bold landmark is found, uses the destination name as a fallback.
 */
function ensureImagePlaceholders(itinerary: string, destinationName: string | null): string {
  // Split by day headings at any level, keeping delimiters.
  const blocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i);

  const result = blocks.map((block) => {
    // Check if this block is a day section
    const headingMatch = block.match(/(#+\s+Day\s+\d+[^\n]*)/i);
    if (!headingMatch) return block;

    // Check if there's already an image placeholder in this block
    if (/!\[IMAGE:/i.test(block)) return block;

    // Find the first bold landmark in this block (excluding the heading itself)
    const linesAfterHeading = block.slice(headingMatch[0].length);
    const boldMatch = linesAfterHeading.match(/\*\*([^*]+)\*\*/);
    const landmark = boldMatch ? boldMatch[1].trim() : (destinationName || 'Landmark');

    // Insert the placeholder right after the heading line
    const headingEnd = block.indexOf(headingMatch[0]) + headingMatch[0].length;
    return block.slice(0, headingEnd) + `\n\n![IMAGE: ${landmark}]` + block.slice(headingEnd);
  });

  return result.join('');
}

export async function hydrateItineraryImages(
  itinerary: string,
  destinationName: string | null = null
): Promise<string> {
  // First, ensure every day has an image placeholder. If the LLM forgot to
  // include one for some days, insert one using the first bold landmark.
  const itineraryWithPlaceholders = ensureImagePlaceholders(itinerary, destinationName);

  // Match placeholders the model may emit, optionally with a fabricated URL.
  const placeholderRegex = /!\[IMAGE:\s*([^\]]+)\](?:\([^)]*\))?/g;
  const matches = Array.from(itineraryWithPlaceholders.matchAll(placeholderRegex));

  if (matches.length === 0) return itinerary;

  // Track used URLs to prevent duplicate images across days.
  const usedUrls = new Set<string>();

  // Kick off the destination fallback image fetch early — it runs in
  // parallel with all the per-day image lookups below.
  const destinationImagePromise = destinationName
    ? getDestinationImageUrl(destinationName).catch(() => null)
    : Promise.resolve(null);

  const imageResults = await Promise.all(
    matches.map(async (match) => {
      const term = match[1].trim();
      const cleanedTerm = cleanTerm(term);
      const fallbackTerms: string[] = [];

      if (destinationName) {
        const dest = destinationName;
        const destLower = dest.toLowerCase();
        const termLower = cleanedTerm.toLowerCase();

        // Don't add destination as fallback if the term IS the destination.
        // Keep fallbacks lean — each one triggers 4 parallel provider calls.
        if (destLower !== termLower) {
          if (/\bmarket\b/i.test(cleanedTerm)) {
            fallbackTerms.push(`${dest} night market street food`);
          }
          fallbackTerms.push(
            `${dest} ${term}`,
            `${term} ${dest}`,
          );
        }
      }

      let url = await getImageForTerm(term, fallbackTerms);

      // If this URL was already used for another landmark, try to find an alternative.
      if (url && usedUrls.has(url)) {
        const altTerms = [
          `${term} photo`,
          destinationName ? `${destinationName} ${term} photo` : '',
        ].filter((t): t is string => Boolean(t));
        const uniqueAltTerms = altTerms.filter(t => !fallbackTerms.includes(t));
        const altUrl = await getImageForTerm(term, [...fallbackTerms, ...uniqueAltTerms]);
        if (altUrl && !usedUrls.has(altUrl)) {
          url = altUrl;
        }
      }

      // Last resort: use the destination image if we couldn't find a landmark image,
      // but only if it hasn't been used yet. Better to show the destination image
      // than no image at all.
      if (!url) {
        const destinationImageUrl = await destinationImagePromise;
        if (destinationImageUrl && !usedUrls.has(destinationImageUrl)) {
          url = destinationImageUrl;
        }
      }

      if (url) usedUrls.add(url);
      return { match: match[0], term, url };
    })
  );

  return imageResults.reduce((acc, { match, term, url }) => {
    if (url) {
      return acc.replace(match, `![${term}](${url})`);
    }
    // Remove the placeholder entirely if no image can be found.
    // A missing image is cleaner than italic text that looks broken.
    return acc.replace(match, '');
  }, itinerary);
}
