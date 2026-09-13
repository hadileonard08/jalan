import { getChatModel } from '../lib/ai-provider';
import { db } from '../db';
import { geocodedLocations } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { RouteLink } from './itinerary-guardrails';
import { optimizeDayRoute, extractStopsWithTimeSlots, type OptimizableStop, type TimeSlot } from '../lib/route-optimizer';

// Generic transit terms that the LLM might use as stop names.
// These don't geocode well and should be treated as "take transit" legs
// rather than walkable destinations.
const GENERIC_TRANSIT_TERMS = [
  'mtr', 'subway', 'metro', 'underground', 'tube', 'u-bahn', 's-bahn',
  'train', 'rail', 'railway', 'jr', 'jr line', 'shinkansen',
  'bus', 'bus stop', 'tram', 'streetcar', 'trolley',
  'ferry', 'boat', 'water taxi',
  'taxi', 'uber', 'ride', 'ride-share', 'rideshare',
  'transit', 'public transport', 'station', 'stop',
];

function isGenericTransitTerm(name: string): boolean {
  const lower = name.toLowerCase().trim();
  // Check if the name IS just a generic term (e.g. "MTR", "Subway")
  if (GENERIC_TRANSIT_TERMS.includes(lower)) return true;
  // Check if the name is a generic term + "station" (e.g. "MTR Station", "Train Station")
  if (GENERIC_TRANSIT_TERMS.some(term => lower === `${term} station` || lower === `${term} stop`)) return true;
  // Filter time-slot headings (with or without emoji prefix and trailing colon)
  // e.g. "🌅 Morning:", "🌞 Afternoon:", "🌙 Evening:"
  if (/^(?:[🌅🌞🌙]\s*)?(?:morning|afternoon|evening|lunch|dinner|breakfast|snack)\s*:?\s*$/iu.test(lower)) return true;
  return false;
}

// Map generic transit terms to a friendly mode label.
function transitTermToMode(name: string): { mode: string; note: string } | null {
  const lower = name.toLowerCase().trim();
  if (lower.includes('mtr') || lower.includes('subway') || lower.includes('metro') || lower.includes('underground') || lower.includes('tube') || lower.includes('u-bahn')) {
    return { mode: '🚇 Subway/Metro', note: 'Take the metro to the next stop' };
  }
  if (lower.includes('train') || lower.includes('rail') || lower.includes('jr') || lower.includes('s-bahn') || lower.includes('shinkansen')) {
    return { mode: '🚆 Train', note: 'Take the train to the next stop' };
  }
  if (lower.includes('bus')) {
    return { mode: '🚌 Bus', note: 'Take the bus to the next stop' };
  }
  if (lower.includes('tram') || lower.includes('streetcar') || lower.includes('trolley')) {
    return { mode: '🚊 Tram', note: 'Take the tram to the next stop' };
  }
  if (lower.includes('ferry') || lower.includes('boat') || lower.includes('water taxi')) {
    return { mode: '⛴️ Ferry', note: 'Take the ferry to the next stop' };
  }
  if (lower.includes('taxi') || lower.includes('uber') || lower.includes('ride')) {
    return { mode: '🚕 Taxi/Ride-share', note: 'Take a taxi or ride-share' };
  }
  // Generic transit
  return { mode: '🚇 Transit', note: 'Take local transit to the next stop' };
}

export interface MapPoint {
  lat: number;
  lon: number;
}

export interface LegInfo {
  from: string;
  to: string;
  walkMinutes: number | null;
  driveMinutes: number | null;
  distanceKm: number | null;
  recommendedMode: string;
  note: string;
}

export interface RouteWaypoint extends MapPoint {
  name: string;
  order: number;
}

export interface DayTransport {
  day: string;
  title: string;
  legs: LegInfo[];
  summary: string;
  waypoints: RouteWaypoint[];
  polyline?: MapPoint[];
  optimizedUrl?: string;
}

export interface TransportPlan {
  cityTransitTips: string;
  estimatedCosts: string;
  days: DayTransport[];
}

interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
}

const FETCH_TIMEOUT_MS = 5000;
const NOMINATIM_DELAY_MS = 1000;

const inFlight = new Map<string, Promise<GeocodeResult | null>>();
const processCache = new Map<string, GeocodeResult | null>();
let lastNominatimAt = 0;
let throttleQueue = Promise.resolve();

function normalizeQueryKey(place: string, city: string): string {
  return `${place.trim().toLowerCase()}:${city.trim().toLowerCase()}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cache for city center coordinates — used to validate day-trip destinations.
const cityCenterCache = new Map<string, { lat: number; lon: number } | null>();

async function getCityCenter(city: string): Promise<{ lat: number; lon: number } | null> {
  const cityKey = city.toLowerCase().split(',')[0].trim();
  if (cityCenterCache.has(cityKey)) return cityCenterCache.get(cityKey)!;

  const headers = { 'User-Agent': 'flight-deal-dashboard/1.0 (transport agent)' };
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (res.ok) {
      const data = (await res.json()) as any[];
      if (data && data.length > 0) {
        const center = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
        cityCenterCache.set(cityKey, center);
        return center;
      }
    }
  } catch { /* ignore */ }
  cityCenterCache.set(cityKey, null);
  return null;
}

// Haversine distance in km.
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeNominatim(place: string, city: string): Promise<GeocodeResult | null> {
  const headers = { 'User-Agent': 'flight-deal-dashboard/1.0 (transport agent)' };
  const cityLower = city.toLowerCase().split(',')[0].trim();

  // Two-tier validation:
  // 1. If display name contains the city → accept (in-city landmark).
  // 2. If within 200km of city center → accept (day-trip destination like
  //    Mount Rainier from Seattle, Versailles from Paris).
  // 3. Otherwise → reject (wrong city/country).
  const MAX_DAY_TRIP_KM = 200;

  const validateResult = async (item: any): Promise<GeocodeResult | null> => {
    if (!item || !item.lat || !item.lon) return null;
    const displayName = (item.display_name || '').toLowerCase();
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);

    // Tier 1: display name contains the city.
    if (displayName.includes(cityLower)) {
      return { lat, lon, displayName: item.display_name };
    }

    // Tier 2: within day-trip distance of the city center.
    const center = await getCityCenter(city);
    if (center) {
      const dist = distanceKm(center.lat, center.lon, lat, lon);
      if (dist <= MAX_DAY_TRIP_KM) {
        return { lat, lon, displayName: item.display_name };
      }
    }

    return null;
  };

  const runRequest = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Primary: full-text query with city appended.
        const query = encodeURIComponent(`${place}, ${city}`);
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=5`,
          { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        );
        if (res.status === 429) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        if (res.ok) {
          const data = (await res.json()) as any[];
          if (data && data.length > 0) {
            for (const item of data) {
              const validated = await validateResult(item);
              if (validated) return validated;
            }
          }
        }

        // Fallback: search place name alone (for day-trip destinations
        // like "Mount Rainier National Park" that aren't in the city).
        // The distance validation prevents wrong-country results.
        const placeParam = encodeURIComponent(place);
        const placeRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${placeParam}&format=json&limit=5`,
          { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        );
        if (placeRes.status === 429) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        if (placeRes.ok) {
          const placeData = (await placeRes.json()) as any[];
          if (placeData && placeData.length > 0) {
            for (const item of placeData) {
              const validated = await validateResult(item);
              if (validated) return validated;
            }
          }
        }

        return null;
      } catch {
        return null;
      }
    }
    return null;
  };

  const next = throttleQueue.then(async () => {
    const elapsed = Date.now() - lastNominatimAt;
    if (elapsed < NOMINATIM_DELAY_MS) {
      await sleep(NOMINATIM_DELAY_MS - elapsed);
    }
    lastNominatimAt = Date.now();
    return runRequest();
  });
  throttleQueue = next.catch(() => null).then(() => undefined);
  return next;
}

export async function geocode(place: string, city: string): Promise<GeocodeResult | null> {
  const queryKey = normalizeQueryKey(place, city);

  const local = processCache.get(queryKey);
  if (local) return local;

  const existing = inFlight.get(queryKey);
  if (existing) return existing;

  const promise = (async () => {
    const cached = await db
      .select()
      .from(geocodedLocations)
      .where(eq(geocodedLocations.queryKey, queryKey))
      .limit(1);
    if (cached.length > 0) {
      // Validate cached result: either the display name contains the city
      // (in-city landmark) OR the coordinates are within 200km of the city
      // center (day-trip destination like Mount Rainier from Seattle).
      const cachedCity = city.toLowerCase().split(',')[0].trim();
      const cachedDisplay = (cached[0].displayName || '').toLowerCase();
      if (cachedDisplay.includes(cachedCity)) {
        return {
          lat: cached[0].lat,
          lon: cached[0].lon,
          displayName: cached[0].displayName || '',
        };
      }
      // Check distance to city center for day-trip destinations.
      const center = await getCityCenter(city);
      if (center) {
        const dist = distanceKm(center.lat, center.lon, cached[0].lat, cached[0].lon);
        if (dist <= 200) {
          return {
            lat: cached[0].lat,
            lon: cached[0].lon,
            displayName: cached[0].displayName || '',
          };
        }
      }
      // Cache entry is stale/wrong — delete it and re-geocode.
      try {
        await db.delete(geocodedLocations).where(eq(geocodedLocations.queryKey, queryKey));
      } catch { /* ignore */ }
    }

    const result = await geocodeNominatim(place, city);
    if (result) {
      try {
        await db.insert(geocodedLocations).values({
          queryKey,
          lat: result.lat,
          lon: result.lon,
          displayName: result.displayName,
        });
      } catch (err) {
        console.error('Failed to cache geocode result:', (err as Error).message);
      }
    }
    return result;
  })().finally(() => {
    inFlight.delete(queryKey);
  });

  inFlight.set(queryKey, promise);
  const result = await promise;
  if (result) processCache.set(queryKey, result);
  return result;
}

async function getOSRMRoute(
  from: GeocodeResult,
  to: GeocodeResult,
  profile: 'walking' | 'driving'
): Promise<{ durationMin: number; distanceKm: number; coordinates: MapPoint[] } | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { 'User-Agent': 'flight-deal-dashboard/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.routes || data.routes.length === 0) return null;
    const route = data.routes[0];
    const coordinates: MapPoint[] = (route.geometry?.coordinates || []).map((c: [number, number]) => ({ lat: c[1], lon: c[0] }));
    return {
      durationMin: Math.round(route.duration / 60),
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      coordinates,
    };
  } catch {
    return null;
  }
}

function recommendMode(walkMin: number | null, driveMin: number | null, distanceKm: number | null): { mode: string; note: string } {
  // No routing data — suggest general options
  if (!walkMin && !driveMin) {
    return { mode: 'Transit/Taxi', note: 'Check local transit or ride-share.' };
  }

  // Short distance — walk
  if (walkMin !== null && walkMin <= 15) {
    return { mode: '🚶 Walk', note: `~${walkMin} min walk` };
  }

  if (walkMin === null && distanceKm !== null) {
    const estimatedWalkMinutes = Math.max(1, Math.round((distanceKm / 4.8) * 60));
    if (distanceKm <= 2) {
      return { mode: '🚶 Walk', note: `About ${estimatedWalkMinutes} min on foot based on distance (${distanceKm}km)` };
    }
    if (driveMin !== null) {
      return { mode: '🚌 Transit/🚕 Taxi', note: `~${driveMin} min by taxi; check local transit (${distanceKm}km)` };
    }
  }

  // Medium distance — walk if driving isn't much faster
  if (walkMin !== null && walkMin <= 25 && (!driveMin || driveMin >= 8)) {
    return { mode: '🚶 Walk', note: `~${walkMin} min walk (${distanceKm}km)` };
  }

  // Short drive but long walk — subway/metro for intra-city
  if (driveMin !== null && driveMin <= 10 && walkMin && walkMin > 25) {
    if (distanceKm !== null && distanceKm <= 3) {
      return { mode: '🚇 Subway/Metro', note: `~${driveMin} min by transit (${distanceKm}km)` };
    }
    return { mode: '🚇 Subway/🚕 Taxi', note: `~${driveMin} min by transit or taxi (${distanceKm}km)` };
  }

  // Medium drive distance — train or subway
  if (distanceKm !== null && distanceKm > 3 && distanceKm <= 5) {
    return { mode: '🚇 Subway/🚕 Taxi', note: `~${driveMin || 15} min by transit or taxi (${distanceKm}km)` };
  }

  // Long distance — use locally available road or public transport
  if (distanceKm !== null && distanceKm > 5 && distanceKm <= 15) {
    return { mode: '🚌 Transit/🚕 Taxi', note: `~${driveMin || 20} min by local transit or taxi (${distanceKm}km)` };
  }

  // Very long distance — avoid assuming a rail network exists
  if (distanceKm !== null && distanceKm > 15) {
    return { mode: '🚌 Transit/🚕 Taxi', note: `~${driveMin || 30} min by local transit or taxi (${distanceKm}km)` };
  }

  // Fallback
  if (walkMin !== null) {
    return { mode: '🚶 Walk/🚇 Transit', note: `~${walkMin} min walk; local transit may be faster` };
  }
  if (driveMin !== null) {
    return { mode: '🚌 Transit/🚕 Taxi', note: `~${driveMin} min by taxi; check local transit` };
  }
  return { mode: '🚌 Transit/🚕 Taxi', note: 'Check local transit or taxi options' };
}

async function buildDayTransport(
  routeLink: RouteLink,
  destination: string,
  dayTimeSlots?: { name: string; timeSlot: TimeSlot }[]
): Promise<DayTransport> {
  // Extract stops from the Google Maps URL (they're encoded as "place, destination" segments).
  const segments = routeLink.url
    .replace('https://www.google.com/maps/dir/', '')
    .split('/')
    .map((s) => decodeURIComponent(s).replace(`, ${destination}`, '').trim())
    .filter(Boolean);

  const legs: LegInfo[] = [];
  const dayPolyline: MapPoint[] = [];
  let waypoints: RouteWaypoint[] = [];

  // Geocode all stops in parallel (with a small concurrency limit).
  const geocoded = await Promise.all(
    segments.map((s) => geocode(s, destination))
  );

  // Build waypoints from successfully geocoded, non-generic stops.
  for (let i = 0; i < geocoded.length; i++) {
    const g = geocoded[i];
    const name = segments[i];
    if (g && !isGenericTransitTerm(name)) {
      waypoints.push({
        name,
        lat: g.lat,
        lon: g.lon,
        order: waypoints.length + 1,
      });
    }
  }

  // If we have time-slot info, run the route optimizer to reorder waypoints
  // to minimize travel time while respecting morning→afternoon→evening order.
  // Airport/departure stops are anchored as the last stop and excluded from
  // reordering (they must always be the final destination).
  const isDepartureStop = (name: string): boolean =>
    /\b(airport|sea-?tac|departure|fly|flight|check-?in|boarding|terminal)\b/i.test(name);

  if (dayTimeSlots && dayTimeSlots.length > 0 && waypoints.length > 2) {
    // Separate departure stops (anchored last) from optimizable stops.
    const departureWps: RouteWaypoint[] = [];
    const regularWps: RouteWaypoint[] = [];
    for (const wp of waypoints) {
      if (isDepartureStop(wp.name)) departureWps.push(wp);
      else regularWps.push(wp);
    }

    // Match each regular waypoint to its time slot by name (case-insensitive).
    const slotByName = new Map<string, TimeSlot>();
    for (const s of dayTimeSlots) {
      slotByName.set(s.name.toLowerCase().trim(), s.timeSlot);
    }
    const optimizable: OptimizableStop[] = [];
    const matchedIndexes: number[] = [];
    for (let i = 0; i < regularWps.length; i++) {
      const wp = regularWps[i];
      const slot = slotByName.get(wp.name.toLowerCase().trim());
      if (slot) {
        optimizable.push({ name: wp.name, lat: wp.lat, lon: wp.lon, timeSlot: slot });
        matchedIndexes.push(i);
      }
    }

    if (optimizable.length > 2) {
      try {
        const optimized = await optimizeDayRoute(optimizable);
        // Rebuild waypoints: optimized matched stops first, then unmatched
        // regular stops, then departure stops anchored at the end.
        const optimizedWaypoints: RouteWaypoint[] = optimized.map((o) => ({
          name: o.name,
          lat: o.lat,
          lon: o.lon,
          order: 0,
        }));
        const matchedSet = new Set(matchedIndexes);
        for (let i = 0; i < regularWps.length; i++) {
          if (!matchedSet.has(i)) {
            optimizedWaypoints.push({ ...regularWps[i], order: 0 });
          }
        }
        // Append departure stops at the end (never reordered).
        for (const dw of departureWps) {
          optimizedWaypoints.push({ ...dw, order: 0 });
        }
        waypoints = optimizedWaypoints.map((wp, i) => ({ ...wp, order: i + 1 }));
        // Rebuild segments and geocoded arrays in the optimized order for leg computation.
        // (We keep the original segments/geocoded for leg-from-name lookups, but use
        // the optimized waypoint order for routing.)
      } catch (err) {
        console.error('Route optimizer failed, using original order:', (err as Error).message);
      }
    }
  }

  // Build a name→geocode lookup so we can route between optimized waypoints.
  const geocodeByName = new Map<string, GeocodeResult | null>();
  for (let i = 0; i < segments.length; i++) {
    geocodeByName.set(segments[i].toLowerCase().trim(), geocoded[i]);
  }

  // Get OSRM routes between consecutive optimized waypoints.
  for (let i = 0; i < waypoints.length - 1; i++) {
    const fromWp = waypoints[i];
    const toWp = waypoints[i + 1];
    const fromName = fromWp.name;
    const toName = toWp.name;
    const from = geocodeByName.get(fromName.toLowerCase().trim()) ?? { lat: fromWp.lat, lon: fromWp.lon, displayName: fromName };
    const to = geocodeByName.get(toName.toLowerCase().trim()) ?? { lat: toWp.lat, lon: toWp.lon, displayName: toName };

    // If either stop is a generic transit term (e.g. "MTR", "Subway", "Train"),
    // don't try to route it — just label it as a transit leg.
    const fromIsGeneric = isGenericTransitTerm(fromName);
    const toIsGeneric = isGenericTransitTerm(toName);
    if (fromIsGeneric || toIsGeneric) {
      const genericName = fromIsGeneric ? fromName : toName;
      const transitInfo = transitTermToMode(genericName);
      legs.push({
        from: fromName,
        to: toName,
        walkMinutes: null,
        driveMinutes: null,
        distanceKm: null,
        recommendedMode: transitInfo?.mode || '🚇 Transit',
        note: transitInfo?.note || 'Take local transit to the next stop',
      });
      continue;
    }

    if (!from || !to) {
      legs.push({
        from: fromName,
        to: toName,
        walkMinutes: null,
        driveMinutes: null,
        distanceKm: null,
        recommendedMode: '🚇 Transit',
        note: `Take local transit from ${fromName} to ${toName}`,
      });
      continue;
    }

    const [walkResult, drive] = await Promise.all([
      getOSRMRoute(from, to, 'walking').catch(() => null),
      getOSRMRoute(from, to, 'driving').catch(() => null),
    ]);
    const routeDistance = walkResult?.distanceKm ?? drive?.distanceKm ?? null;

    if (routeDistance !== null && routeDistance > 100) {
      legs.push({
        from: fromName,
        to: toName,
        walkMinutes: null,
        driveMinutes: null,
        distanceKm: null,
        recommendedMode: '🚌 Transit/🚕 Taxi',
        note: `Check a local route from ${fromName} to ${toName}; automated routing returned an invalid result`,
      });
      continue;
    }
    const walk = walkResult && routeDistance !== null && walkResult.durationMin < routeDistance * 6
      ? null
      : walkResult;

    const { mode, note } = recommendMode(
      walk?.durationMin ?? null,
      drive?.durationMin ?? null,
      routeDistance
    );

    // Choose the geometry that matches the recommended mode: walking shape
    // for walkable legs, driving shape for transit/taxi legs. Falls back to
    // whichever geometry is available.
    const isWalkingMode = mode.includes('Walk');
    const preferredGeometry = isWalkingMode
      ? (walk?.coordinates?.length ? walk.coordinates : null)
      : (drive?.coordinates?.length ? drive.coordinates : null);
    const legPolyline = preferredGeometry
      ?? (drive?.coordinates?.length ? drive.coordinates : null)
      ?? (walkResult?.coordinates?.length ? walkResult.coordinates : null);
    if (legPolyline) {
      if (i === 0) {
        dayPolyline.push(...legPolyline);
      } else {
        // Avoid duplicating the shared waypoint between consecutive legs.
        dayPolyline.push(...legPolyline.slice(1));
      }
    }

    legs.push({
      from: fromName,
      to: toName,
      walkMinutes: walk?.durationMin ?? null,
      driveMinutes: drive?.durationMin ?? null,
      distanceKm: routeDistance,
      recommendedMode: mode,
      note,
    });
  }

  // Build a brief summary.
  const modes = legs.map((l) => l.recommendedMode);
  const walkCount = modes.filter((m) => m === 'Walk').length;
  const transitCount = modes.length - walkCount;
  const summary = legs.length > 0
    ? `${legs.length} legs: ${walkCount} walkable, ${transitCount} need transit/ride-share`
    : 'No route data available';

  // Build an optimized Google Maps URL from the reordered waypoints.
  const optimizedUrl = waypoints.length >= 2
    ? `https://www.google.com/maps/dir/${waypoints.map((wp) => encodeURIComponent(`${wp.name}, ${destination}`)).join('/')}`
    : routeLink.url;

  return {
    day: routeLink.day,
    title: routeLink.title || '',
    legs,
    summary,
    waypoints,
    polyline: dayPolyline.length > 0 ? dayPolyline : undefined,
    optimizedUrl,
  };
}

async function generateCityTransitTips(
  destination: string,
  dayTransports: DayTransport[]
): Promise<{ tips: string; costs: string }> {
  const llm = getChatModel(0.3);
  if (!llm) return { tips: '', costs: '' };

  const legSummary = dayTransports
    .map((d) => `Day ${d.day}: ${d.summary}`)
    .join('\n');

  const prompt = `You are a local transport expert for ${destination}. Based on the itinerary below, provide practical transport advice.

Daily route summary:
${legSummary}

Provide TWO sections:

1. "Getting Around" — 3-4 short bullet points with the most practical transit tips for ${destination}:
   - What transit pass/card to get and approximate cost
   - Best app for navigation or ride-share
   - Any cultural tips (e.g. don't eat on transit, tap in/out, etc.)
   - When to walk vs. take transit based on the route data

2. "Estimated Transport Costs" — a short table with rough per-person costs:
   | Option | Estimated Cost |
   |--------|---------------|
   Include: day transit pass, single ride, taxi base fare, ride-share typical, and weekly total estimate if relevant.

Keep it concise and practical. Use markdown. Only include real, well-known options for ${destination}.`;

  try {
    const res = await llm.invoke(prompt);
    const content = (res.content as string).trim();
    // Split into the two sections.
    const costIdx = content.search(/#{1,3}\s*Estimated Transport/i);
    if (costIdx > 0) {
      return {
        tips: content.slice(0, costIdx).trim(),
        costs: content.slice(costIdx).trim(),
      };
    }
    return { tips: content, costs: '' };
  } catch {
    return { tips: '', costs: '' };
  }
}

export async function buildTransportPlan(
  routeLinks: RouteLink[],
  destination: string,
  itinerary?: string,
  // Partial refreshes reuse the existing city tips, so they can skip the LLM call.
  options?: { skipCityTips?: boolean }
): Promise<TransportPlan | null> {
  if (!routeLinks || routeLinks.length === 0 || !destination) return null;

  // If we have the itinerary text, extract per-day time-slot info for the
  // route optimizer. Map day number → list of {name, timeSlot}.
  const dayTimeSlots: Record<string, { name: string; timeSlot: TimeSlot }[]> = {};
  if (itinerary) {
    const dayBlocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
    for (const block of dayBlocks) {
      const headingMatch = block.match(/#+\s+Day\s+(\d+)/i);
      if (!headingMatch) continue;
      const dayNum = headingMatch[1];
      const stops = extractStopsWithTimeSlots(block);
      if (stops.length > 0) dayTimeSlots[dayNum] = stops;
    }
  }

  // Process all days concurrently. Geocode results are cached so repeated
  // place names across days don't trigger extra Nominatim calls. Each fetch
  // has AbortSignal.timeout so a slow response won't block everything.
  const dayTransports = await Promise.all(
    routeLinks.map((rl) => buildDayTransport(rl, destination, dayTimeSlots[rl.day]))
  );

  // Generate city-level transit tips concurrently — no need to wait since
  // the day transports are already resolved.
  const { tips, costs } = options?.skipCityTips
    ? { tips: '', costs: '' }
    : await generateCityTransitTips(destination, dayTransports);

  return {
    cityTransitTips: tips,
    estimatedCosts: costs,
    days: dayTransports,
  };
}

function formatLegNote(leg: LegInfo): string {
  // The note already contains the duration and distance.
  // Format: **🚶 Walk** · ~12 min walk — Senso-ji → Tokyo Skytree
  return `- **${leg.recommendedMode}** · ${leg.note} — ${leg.from} → ${leg.to}`;
}

function formatDayNote(day: DayTransport): string {
  if (!day.legs || day.legs.length === 0) return '';
  const lines = day.legs.map(formatLegNote);
  return `\n\n**🚶 Getting around (real times via routing):**\n${lines.join('\n')}`;
}

/**
 * Injects real transport notes from the transport agent into each day's
 * section of the itinerary markdown. Finds day headings at any level
 * (## Day 1, ### Day 1, etc.) and appends the transport note at the end
 * of that day's block (before the next day heading).
 */
export function injectTransportNotes(itinerary: string, plan: TransportPlan | null): string {
  if (!plan || !plan.days || plan.days.length === 0) return itinerary;

  // Build a map of day number → formatted note
  const notesByDay = new Map<string, string>();
  for (const day of plan.days) {
    const note = formatDayNote(day);
    if (note) notesByDay.set(day.day, note);
  }

  if (notesByDay.size === 0) return itinerary;

  // Split by day headings at any level, keeping delimiters
  const blocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i);

  const result = blocks.map((block) => {
    const match = block.match(/#+\s+Day\s+(\d+)/i);
    if (!match) return block;
    const dayNum = match[1];
    const note = notesByDay.get(dayNum);
    if (!note) return block;
    // Append the transport note at the end of this day's block
    return block.trimEnd() + note + '\n';
  });

  return result.join('');
}
