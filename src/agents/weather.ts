import { AIRPORT_NAMES } from '../lib/airports';
import { z } from 'zod';
import type { WeatherSnapshot } from '../lib/chat-state';

const WEATHER_CITIES: Record<string, string> = {
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

interface DailyWeather {
  date: string;
  maxTemp: number;
  minTemp: number;
  precipitation: number;
  condition: string;
}

function wmoCodeToCondition(code: number): string {
  if (code === 0) return 'Clear sky';
  if ([1, 2, 3].includes(code)) return 'Partly cloudy';
  if ([45, 48].includes(code)) return 'Foggy';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Unknown';
}

function cloudCoverToCondition(cloudCover: number): string {
  if (cloudCover < 20) return 'Clear sky';
  if (cloudCover < 50) return 'Partly cloudy';
  if (cloudCover < 80) return 'Cloudy';
  return 'Overcast';
}

function isFutureDate(startDate: Date): boolean {
  const today = new Date();
  const daysOut = Math.floor((startDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  // Open-Meteo's forecast API only gives a reliable ~16-day forecast.
  // Beyond that, use the climate projection API instead.
  return daysOut > 14;
}

export async function getWeatherForecast(destinationCode: string, startDate: Date, endDate: Date, destinationName?: string): Promise<string | null> {
  // Try IATA code lookup first, then fall back to the destination city name
  const city = WEATHER_CITIES[destinationCode] || AIRPORT_NAMES[destinationCode] || destinationName || destinationCode;

  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
    if (!geoRes.ok) return null;
    const geoData = await geoRes.json() as any;
    if (!geoData.results || geoData.results.length === 0) return null;

    const { latitude, longitude, name, country } = geoData.results[0];
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];

    let days: DailyWeather[] = [];

    if (isFutureDate(startDate)) {
      // Use Open-Meteo Climate Change API for long-range (CMIP6 projections through 2050)
      const climateRes = await fetch(
        `https://climate-api.open-meteo.com/v1/climate?latitude=${latitude}&longitude=${longitude}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,cloud_cover_mean&timezone=auto`
      );
      if (!climateRes.ok) return null;
      const data = await climateRes.json() as any;
      if (!data.daily) return null;

      days = data.daily.time.map((date: string, i: number) => ({
        date,
        maxTemp: data.daily.temperature_2m_max[i],
        minTemp: data.daily.temperature_2m_min[i],
        precipitation: data.daily.precipitation_sum[i],
        condition: cloudCoverToCondition(data.daily.cloud_cover_mean[i] ?? 0)
      }));

      const summary = days.map(d => {
        const rain = d.precipitation > 0 ? `, ${d.precipitation}mm rain` : '';
        return `- **${d.date}**: ${d.condition}, high ${Math.round(d.maxTemp)}°C / low ${Math.round(d.minTemp)}°C${rain}`;
      }).join('\n');

      return `## 🌤️ Climate Outlook (long-range projection) for ${name}${country ? `, ${country}` : ''}\n\n${summary}`;
    }

    // Use live forecast for near-term trips
    const forecastRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto`
    );
    if (!forecastRes.ok) return null;
    const data = await forecastRes.json() as any;
    if (!data.daily) return null;

    days = data.daily.time.map((date: string, i: number) => ({
      date,
      maxTemp: data.daily.temperature_2m_max[i],
      minTemp: data.daily.temperature_2m_min[i],
      precipitation: data.daily.precipitation_sum[i],
      condition: wmoCodeToCondition(data.daily.weathercode[i])
    }));

    const summary = days.map(d => {
      const rain = d.precipitation > 0 ? `, ${d.precipitation}mm rain` : '';
      return `- **${d.date}**: ${d.condition}, high ${Math.round(d.maxTemp)}°C / low ${Math.round(d.minTemp)}°C${rain}`;
    }).join('\n');

    return `## 🌤️ Weather Outlook for ${name}${country ? `, ${country}` : ''}\n\n${summary}`;
  } catch (error) {
    console.log('Weather lookup failed:', (error as Error).message);
    return null;
  }
}

const weatherCoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const departureForecastSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    precipitation_probability_max: z.array(z.number().min(0).max(100).nullable()),
    weather_code: z.array(z.number().int().min(0).max(99).nullable()),
    temperature_2m_max: z.array(z.number().finite().nullable()),
    temperature_2m_min: z.array(z.number().finite().nullable()),
    wind_gusts_10m_max: z.array(z.number().nonnegative().finite().nullable()),
  }),
});

const snapshotForecastSchema = z.object({
  timezone: z.string().nullable().optional(),
  daily: z.object({
    time: z.array(z.string()),
    precipitation_probability_max: z.array(z.number().min(0).max(100).nullable()),
    weather_code: z.array(z.number().int().min(0).max(99).nullable()),
    temperature_2m_max: z.array(z.number().finite().nullable()),
    temperature_2m_min: z.array(z.number().finite().nullable()),
    wind_gusts_10m_max: z.array(z.number().nonnegative().finite().nullable()),
    precipitation_sum: z.array(z.number().nonnegative().finite().nullable()),
  }),
});

// Resolve the coordinates used for weather lookups: prefer coordinates already
// saved with the trip's route, otherwise geocode the destination.
async function resolveDestinationCoordinates({
  destination,
  destinationCode,
  waypoints,
}: {
  destination: string;
  destinationCode?: string | null;
  waypoints?: unknown;
}): Promise<{ lat: number; lon: number }> {
  const savedPoint = Array.isArray(waypoints)
    ? waypoints.find((point) => weatherCoordinatesSchema.safeParse(point).success)
    : undefined;
  const parsedPoint = weatherCoordinatesSchema.safeParse(savedPoint);
  if (parsedPoint.success) return parsedPoint.data;

  const code = destinationCode?.toUpperCase() || '';
  const city = WEATHER_CITIES[code] || AIRPORT_NAMES[code] || destination;
  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.search = new URLSearchParams({ name: city, count: '1', language: 'en' }).toString();
  const geoResponse = await fetch(geoUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!geoResponse.ok) throw new Error('Destination geocoding failed');
  const geoData = await geoResponse.json();
  const location = geoData?.results?.[0];
  const parsedLocation = weatherCoordinatesSchema.safeParse({ lat: location?.latitude, lon: location?.longitude });
  if (!parsedLocation.success) throw new Error('Destination coordinates unavailable');
  return parsedLocation.data;
}

// Turn a single day of forecast data into a human-readable alert, or null when
// nothing is worth warning about. Pure so both the alert and snapshot paths
// share exactly the same thresholds.
export function buildWeatherAlert(
  destination: string,
  date: string,
  day: { probability: number; code: number; high: number; low: number; gusts: number },
): string | null {
  const { probability, code, high, low, gusts } = day;
  const warnings: string[] = [];
  const freezing = [56, 57, 66, 67].includes(code);
  const snow = [71, 73, 75, 77, 85, 86].includes(code);
  if (probability > 50) {
    warnings.push(freezing || snow
      ? `${probability}% chance of precipitation. Pack warm, waterproof layers.`
      : `${probability}% chance of rain. Don't forget an umbrella.`);
  }
  if ([95, 96, 99].includes(code)) warnings.push('Thunderstorms are forecast. Consider indoor alternatives.');
  if ([65, 82].includes(code)) warnings.push('Heavy rain is forecast. Allow extra travel time.');
  if (freezing) warnings.push('Freezing rain or drizzle is forecast. Watch for slippery paths and travel disruption.');
  if (snow) warnings.push('Snow is forecast. Pack warm layers and check local travel conditions.');
  if (high >= 35) warnings.push(`Heat up to ${Math.round(high)}°C is forecast. Stay hydrated and plan breaks indoors.`);
  if (low <= -10) warnings.push(`Cold down to ${Math.round(low)}°C is forecast. Pack insulated layers.`);
  if (gusts >= 60) warnings.push(`Strong wind gusts up to ${Math.round(gusts)} km/h are forecast. Reconsider exposed outdoor activities.`);

  return warnings.length ? `Heads up! Weather in ${destination} on ${date}: ${warnings.join(' ')}` : null;
}

export async function getDepartureWeatherAlert({
  destination,
  destinationCode,
  departureDate,
  waypoints,
}: {
  destination: string;
  destinationCode?: string | null;
  departureDate: string;
  waypoints?: unknown;
}): Promise<string | null> {
  const coordinates = await resolveDestinationCoordinates({ destination, destinationCode, waypoints });

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(coordinates.lat),
    longitude: String(coordinates.lon),
    start_date: departureDate,
    end_date: departureDate,
    daily: 'precipitation_probability_max,weather_code,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max',
    timezone: 'auto',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
  }).toString();
  const response = await fetch(forecastUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Departure weather forecast failed');
  const { daily } = departureForecastSchema.parse(await response.json());
  const index = daily.time.indexOf(departureDate);
  const probability = daily.precipitation_probability_max[index];
  const code = daily.weather_code[index];
  const high = daily.temperature_2m_max[index];
  const low = daily.temperature_2m_min[index];
  const gusts = daily.wind_gusts_10m_max[index];
  if (index < 0 || probability == null || code == null || high == null || low == null || gusts == null) {
    throw new Error('Departure date forecast is incomplete');
  }

  return buildWeatherAlert(destination, departureDate, { probability, code, high, low, gusts });
}

// Fetch the live daily forecast for a destination, used by the One Stop
// Weather tab. Covers the next 16 days (Open-Meteo's forecast limit).
export async function getDestinationWeatherSnapshot({
  destination,
  destinationCode,
  waypoints,
}: {
  destination: string;
  destinationCode?: string | null;
  waypoints?: unknown;
}): Promise<WeatherSnapshot> {
  const coordinates = await resolveDestinationCoordinates({ destination, destinationCode, waypoints });
  const today = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const endDate = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(coordinates.lat),
    longitude: String(coordinates.lon),
    start_date: startDate,
    end_date: endDate,
    daily: 'precipitation_probability_max,weather_code,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,precipitation_sum',
    timezone: 'auto',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
  }).toString();
  const response = await fetch(forecastUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Destination weather forecast failed');
  const { daily, timezone } = snapshotForecastSchema.parse(await response.json());

  const days = daily.time
    .map((date, index) => {
      const code = daily.weather_code[index] ?? null;
      return {
        date,
        code,
        condition: code == null ? 'Unknown' : wmoCodeToCondition(code),
        maxTemp: daily.temperature_2m_max[index] ?? null,
        minTemp: daily.temperature_2m_min[index] ?? null,
        precipitationMm: daily.precipitation_sum[index] ?? null,
        precipitationProbability: daily.precipitation_probability_max[index] ?? null,
        windGusts: daily.wind_gusts_10m_max[index] ?? null,
      };
    })
    // The far end of the 16-day window can come back empty; drop those days
    // rather than rendering blank forecast cards.
    .filter((day) => day.code != null || day.maxTemp != null || day.minTemp != null);
  if (days.length === 0) throw new Error('Destination weather forecast is empty');

  return { updatedAt: new Date().toISOString(), timezone: timezone ?? null, days };
}
