/**
 * Test: venue status via OpenStreetMap, with Wikipedia as fallback.
 *
 * Nothing used to answer "is this still open?" — the guardrails only confirmed a
 * venue exists, so SIFF Cinema Egyptian (permanently closed) passed every check.
 *
 * The parsing tests are pure. The live section queries Overpass for the real
 * case; Overpass is fair-use and throttles, so a throttled run reports SKIPPED
 * rather than failing the suite.
 *
 * Usage:
 *   npx tsx scripts/test-venue-status.ts
 */

import 'dotenv/config';
import { latestClosingMinutes, fetchVenueStatus, findEveningHoursConflicts } from '../src/lib/venue-status';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

function skip(label: string, why: string) {
  console.log(`  ⏭  SKIP  ${label} (${why})`);
}

const hours = (h: string) => latestClosingMinutes(h);
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: venue status (OSM / Overpass + Wikipedia fallback)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('latestClosingMinutes — reads real OSM hours:');
  check('simple range', hours('09:00-18:00'), at('18:00'));
  check('weekday groups take the latest close', hours('Mo-Th 09:00-22:00; Fr-Su 08:00-00:00'), at('00:00') + 24 * 60);
  check('weekend split', hours('Mo-Sa 09:00-18:00; Su 09:00-17:00'), at('18:00'));
  check('one late day keeps it open', hours('Mo-Su 11:00-18:00; Fr,Sa 11:00-19:00'), at('19:00'));
  check('holiday exclusions are ignored, not misread', hours('Mo-Sa 09:00-18:00; Nov Th[4] off; Dec 25 off'), null);

  console.log('\nlatestClosingMinutes — refuses to guess:');
  check('sunrise/sunset', hours('sunrise-sunset'), null);
  check('open-ended', hours('24/7'), null);
  check('empty', hours(''), null);
  check('garbage', hours('closed indefinitely due to water damage'), null);

  console.log('\nfindEveningHoursConflicts — pure, with injected status:');
  const itinerary = `# Seattle

## Day 1
**🌅 Morning:**
See the **Museum of Flight**.

**🌙 Evening:**
Dinner near **Pike Place Market**.

## Day 2
**🌙 Evening:**
Wander **Chihuly Garden and Glass**.
`;
  const fake = new Map([
    ['Pike Place Market', { name: 'Pike Place Market', openingHours: 'Mo-Sa 09:00-18:00; Su 09:00-17:00', source: 'osm' as const }],
    ['Chihuly Garden and Glass', { name: 'Chihuly Garden and Glass', openingHours: 'Mo-Su 11:00-18:00; Fr,Sa 11:00-19:00', source: 'osm' as const }],
    ['Museum of Flight', { name: 'Museum of Flight', openingHours: '10:00-17:00', source: 'osm' as const }],
  ]);
  const conflicts = findEveningHoursConflicts(itinerary, fake);
  check('flags the market that shuts at 18:00', conflicts.map((c) => c.name), ['Pike Place Market']);
  check('reports the closing time', conflicts[0]?.closesAt, '18:00');
  check('leaves the 19:00 venue alone', conflicts.some((c) => c.name.includes('Chihuly')), false);
  check('ignores a daytime stop', conflicts.some((c) => c.name.includes('Museum of Flight')), false);

  console.log('\nLive Overpass — the reported case:');
  const live = await fetchVenueStatus(
    ['SIFF Cinema Egyptian', 'Space Needle', 'Pike Place Market'],
    'Seattle',
  );
  if (live.size === 0) {
    skip('SIFF Cinema Egyptian is flagged as closed', 'Overpass returned nothing (throttled?)');
  } else {
    const egyptian = live.get('SIFF Cinema Egyptian');
    check('SIFF Cinema Egyptian is flagged as closed', !!egyptian?.closed, true);
    check('with the OSM evidence', /out of use|closed/i.test(egyptian?.closed || ''), true);
    check('Space Needle is NOT flagged', !!live.get('Space Needle')?.closed, false);
    check('Space Needle reports real hours', !!live.get('Space Needle')?.openingHours, true);
    check('Pike Place Market is NOT flagged', !!live.get('Pike Place Market')?.closed, false);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

export {};
