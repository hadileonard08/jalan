import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../src/db';
import { getDepartureWeatherAlert } from '../src/agents/weather';

const targetDate = '2026-09-13';
const point = { lat: 43.0389, lon: -87.9065 };
const forecast = (probability: number | null = 20, code: number | null = 0) => ({
  daily: {
    time: [targetDate],
    precipitation_probability_max: [probability],
    weather_code: [code],
    temperature_2m_max: [24],
    temperature_2m_min: [15],
    wind_gusts_10m_max: [20],
  },
});

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS: ${name}`);
  } finally {
    mock.restoreAll();
  }
}

async function main() {
  await check('uses saved destination coordinates and the exact date without geocoding', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      calls++;
      const url = new URL(input);
      assert.equal(url.origin, 'https://api.open-meteo.com');
      assert.equal(url.searchParams.get('latitude'), String(point.lat));
      assert.equal(url.searchParams.get('longitude'), String(point.lon));
      assert.equal(url.searchParams.get('start_date'), targetDate);
      assert.equal(url.searchParams.get('end_date'), targetDate);
      assert.equal(url.searchParams.get('timezone'), 'auto');
      assert.ok(url.searchParams.get('daily')?.includes('precipitation_probability_max'));
      assert.equal(init?.cache, 'no-store');
      assert.ok(init?.signal);
      return Response.json(forecast(75));
    });
    const alert = await getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] });
    assert.match(alert || '', /Milwaukee/);
    assert.match(alert || '', /2026-09-13/);
    assert.match(alert || '', /75%/);
    assert.match(alert || '', /umbrella/i);
    assert.equal(calls, 1);
  });

  for (const probability of [0, 49, 50, 51]) {
    await check(`rain threshold is strictly greater than 50% (${probability}%)`, async () => {
      mock.method(globalThis, 'fetch', async () => Response.json(forecast(probability)));
      const alert = await getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] });
      assert.equal(alert !== null, probability > 50);
    });
  }

  for (const [code, expected] of [[95, /thunderstorm/i], [66, /freezing/i], [75, /snow/i], [65, /heavy rain/i]] as const) {
    await check(`WMO weather code ${code} creates an alert even with low precipitation probability`, async () => {
      mock.method(globalThis, 'fetch', async () => Response.json(forecast(20, code)));
      assert.match(await getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] }) || '', expected);
    });
  }

  await check('warns about extreme heat, cold, and wind gusts', async () => {
    const data = forecast();
    data.daily.temperature_2m_max = [35];
    data.daily.temperature_2m_min = [-10];
    data.daily.wind_gusts_10m_max = [60];
    mock.method(globalThis, 'fetch', async () => Response.json(data));
    const alert = await getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] });
    assert.match(alert || '', /35°C/);
    assert.match(alert || '', /-10°C/);
    assert.match(alert || '', /60 km\/h/);
  });

  await check('selects the forecast by date instead of blindly using the first entry', async () => {
    const data = forecast(10);
    data.daily.time = ['2026-09-12', targetDate];
    data.daily.precipitation_probability_max = [10, 80];
    data.daily.weather_code = [0, 61];
    data.daily.temperature_2m_max = [24, 24];
    data.daily.temperature_2m_min = [15, 15];
    data.daily.wind_gusts_10m_max = [20, 20];
    mock.method(globalThis, 'fetch', async () => Response.json(data));
    assert.match(await getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] }) || '', /80%/);
  });

  await check('geocodes a destination when saved route coordinates are unavailable or invalid', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      calls++;
      const url = new URL(input);
      assert.ok(init?.signal);
      if (calls === 1) {
        assert.equal(url.origin, 'https://geocoding-api.open-meteo.com');
        assert.equal(url.searchParams.get('name'), 'Tokyo');
        return Response.json({ results: [{ latitude: 35.68, longitude: 139.69 }] });
      }
      assert.equal(url.searchParams.get('latitude'), '35.68');
      return Response.json(forecast(75));
    });
    assert.ok(await getDepartureWeatherAlert({ destination: 'Tokyo', destinationCode: 'NRT', departureDate: targetDate, waypoints: [{ lat: 999, lon: 0 }] }));
    assert.equal(calls, 2);
  });

  await check('accepts zero coordinates rather than treating them as missing', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL) => {
      assert.equal(new URL(input).searchParams.get('latitude'), '0');
      return Response.json(forecast(20));
    });
    assert.equal(await getDepartureWeatherAlert({ destination: 'Equator', departureDate: targetDate, waypoints: [{ lat: 0, lon: 0 }] }), null);
  });

  for (const data of [{}, forecast(null, null), { ...forecast(), daily: { ...forecast().daily, time: ['2026-09-12'] } }]) {
    await check('missing or unusable forecast data is a failure, not an all-clear', async () => {
      mock.method(globalThis, 'fetch', async () => Response.json(data));
      await assert.rejects(() => getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] }));
    });
  }

  await check('HTTP failures and timeouts propagate without creating a false all-clear', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
    await assert.rejects(() => getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] }));
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => { throw new Error('Request timed out'); });
    await assert.rejects(() => getDepartureWeatherAlert({ destination: 'Milwaukee', departureDate: targetDate, waypoints: [point] }));
  });

  const { GET } = await import('../src/app/api/cron/weather-check/route');
  const originalSecret = process.env.CRON_SECRET;
  const request = (authorization?: string) => new NextRequest('http://localhost:3000/api/cron/weather-check', {
    headers: authorization ? { authorization } : {},
  });

  try {
    await check('cron rejects missing configuration, missing headers, and incorrect secrets before accessing data', async () => {
      mock.method(db, 'select', () => { throw new Error('Unauthorized database access'); });
      mock.method(globalThis, 'fetch', () => { throw new Error('Unauthorized weather access'); });
      delete process.env.CRON_SECRET;
      assert.equal((await GET(request('Bearer undefined'))).status, 401);
      process.env.CRON_SECRET = 'weather-cron-test-secret';
      assert.equal((await GET(request())).status, 401);
      assert.equal((await GET(request('Bearer wrong-secret'))).status, 401);
    });

    await check('cron targets two UTC calendar days ahead and only persists server-generated weather alerts', async () => {
      mock.method(Date, 'now', () => Date.parse('2026-09-11T08:00:00Z'));
      const trips = [
        { id: 'rainy-trip', destination: 'Milwaukee', destinationCode: 'MKE', waypoints: [point], weatherAlert: null },
        { id: 'same-destination', destination: 'Milwaukee', destinationCode: 'MKE', waypoints: [point], weatherAlert: null },
        { id: 'clear-trip', destination: 'Clear City', destinationCode: null, waypoints: [{ lat: 10, lon: 10 }], weatherAlert: 'Old alert' },
        { id: 'failed-trip', destination: 'Failed City', destinationCode: null, waypoints: [{ lat: 20, lon: 20 }], weatherAlert: 'Keep this alert' },
      ];
      let queryChecked = false;
      mock.method(db, 'select', () => ({
        from: () => ({
          where: async (where: SQL) => {
            const query = new PgDialect().sqlToQuery(where);
            assert.ok(query.params.includes(targetDate));
            assert.match(query.sql, /startDate/);
            assert.match(query.sql, /dates/);
            queryChecked = true;
            return trips;
          },
        }),
      }));
      const updates: { id: string; weatherAlert: string | null }[] = [];
      mock.method(db, 'update', () => ({
        set: (update: { weatherAlert: string | null }) => ({
          where: async (where: SQL) => {
            assert.deepEqual(Object.keys(update), ['weatherAlert']);
            const query = new PgDialect().sqlToQuery(where);
            updates.push({ id: String(query.params[0]), weatherAlert: update.weatherAlert });
          },
        }),
      }));
      let fetches = 0;
      mock.method(globalThis, 'fetch', async (input: string | URL) => {
        fetches++;
        const latitude = new URL(input).searchParams.get('latitude');
        if (latitude === '20') return new Response('', { status: 503 });
        return Response.json(forecast(latitude === '10' ? 0 : 80));
      });
      const response = await GET(request('Bearer weather-cron-test-secret'));
      const result = await response.json();
      assert.equal(queryChecked, true);
      assert.equal(result.targetDate, targetDate);
      assert.equal(result.checked, 3);
      assert.equal(result.alerts, 2);
      assert.equal(result.failed, 1);
      assert.equal(response.status, 500);
      assert.equal(fetches, 3);
      assert.equal(updates.length, 3);
      assert.equal(updates.find((update) => update.id === 'clear-trip')?.weatherAlert, null);
      assert.equal(updates.some((update) => update.id === 'failed-trip'), false);
      assert.match(updates.find((update) => update.id === 'rainy-trip')?.weatherAlert || '', /80%/);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
