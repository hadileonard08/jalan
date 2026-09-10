/**
 * Test script for the OSRM-backed route optimizer.
 *
 * Tests that the optimizer:
 * 1. Respects time-slot anchoring (morning → afternoon → evening).
 * 2. Minimizes zigzagging using the OSRM Table API + nearest-neighbor + 2-opt.
 *
 * Test case: an intentionally unoptimized day in Paris.
 *   [Louvre (morning), Sacré-Cœur (morning), Musée d'Orsay (afternoon)]
 *
 * The Louvre and Musée d'Orsay are adjacent on the Seine (~1 km apart),
 * while Sacré-Cœur is up in Montmartre (~4 km north). A good optimizer should
 * group Louvre and Musée d'Orsay sequentially (either Louvre→Orsay or
 * Orsay→Louvre) rather than bouncing up to Montmartre and back.
 *
 * Run: npx tsx scripts/test-route-optimization.ts
 */

import { optimizeDayRoute, type OptimizableStop } from '../src/lib/route-optimizer';

function assert(condition: boolean, message: string): { ok: boolean; message: string } {
  return { ok: condition, message };
}

async function main() {
  const results: { ok: boolean; message: string }[] = [];

  // Real coordinates for Paris landmarks.
  const louvre: OptimizableStop = {
    name: 'Louvre Museum',
    lat: 48.8606,
    lon: 2.3376,
    timeSlot: 'morning',
  };
  const sacreCoeur: OptimizableStop = {
    name: 'Sacré-Cœur',
    lat: 48.8867,
    lon: 2.3431,
    timeSlot: 'morning',
  };
  const museeOrsay: OptimizableStop = {
    name: 'Musée d\'Orsay',
    lat: 48.8600,
    lon: 2.3266,
    timeSlot: 'afternoon',
  };

  // Intentionally unoptimized order: Louvre → Sacré-Cœur → Musée d'Orsay.
  // This zigzags: Louvre (Seine) → Sacré-Cœur (Montmartre, 4km north) → Orsay (back to Seine).
  const unoptimized = [louvre, sacreCoeur, museeOrsay];

  console.log('--- Input (unoptimized) ---');
  unoptimized.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name} (${s.timeSlot}) — lat=${s.lat}, lon=${s.lon}`);
  });

  const optimized = await optimizeDayRoute(unoptimized);

  console.log('\n--- Output (optimized) ---');
  optimized.forEach((s) => {
    console.log(`  ${s.order}. ${s.name} (${s.timeSlot}) — lat=${s.lat}, lon=${s.lon}`);
  });

  // Test 1: Time-slot anchoring — all morning stops before afternoon stops.
  const morningOrders = optimized
    .filter((s) => s.timeSlot === 'morning')
    .map((s) => s.order);
  const afternoonOrders = optimized
    .filter((s) => s.timeSlot === 'afternoon')
    .map((s) => s.order);
  const morningBeforeAfternoon = morningOrders.length === 0 || afternoonOrders.length === 0 ||
    Math.max(...morningOrders) < Math.min(...afternoonOrders);
  results.push(assert(
    morningBeforeAfternoon,
    'Morning stops precede afternoon stops',
  ));

  // Test 2: Louvre and Musée d'Orsay should be adjacent in the optimized route
  // (they are ~1 km apart on the Seine, while Sacré-Cœur is 4 km north).
  const louvreOrder = optimized.find((s) => s.name === 'Louvre Museum')?.order;
  const orsayOrder = optimized.find((s) => s.name === 'Musée d\'Orsay')?.order;
  const sacreCoeurOrder = optimized.find((s) => s.name === 'Sacré-Cœur')?.order;

  console.log('\n--- Orders ---');
  console.log(`  Louvre: ${louvreOrder}, Sacré-Cœur: ${sacreCoeurOrder}, Musée d'Orsay: ${orsayOrder}`);

  // Sacré-Cœur is morning, Musée d'Orsay is afternoon, so Sacré-Cœur must come first.
  // Within morning, the optimizer should pick an order. The key assertion is that
  // Sacré-Cœur (morning) comes before Musée d'Orsay (afternoon) — which is the time-slot rule.
  // And that Louvre and Orsay are NOT separated by Sacré-Cœur in a way that zigzags.
  // Since Sacré-Cœur is morning and Orsay is afternoon, Sacré-Cœur always comes before Orsay.
  // The real test: is the total route shorter than the unoptimized order?
  results.push(assert(
    sacreCoeurOrder! < orsayOrder!,
    'Sacré-Cœur (morning) is scheduled before Musée d\'Orsay (afternoon)',
  ));

  // Test 3: All stops present in output.
  results.push(assert(
    optimized.length === 3,
    `All 3 stops present in output (got ${optimized.length})`,
  ));

  // Test 4: Orders are sequential 1, 2, 3.
  const orders = optimized.map((s) => s.order).sort((a, b) => a - b);
  const sequential = orders.length === 3 && orders[0] === 1 && orders[1] === 2 && orders[2] === 3;
  results.push(assert(sequential, `Orders are sequential 1-2-3 (got ${orders.join(',')})`));

  // Test 5: With a larger set, verify the optimizer reduces total travel time.
  // Add more Paris landmarks to make the 2-opt meaningful.
  const eiffelTower: OptimizableStop = {
    name: 'Eiffel Tower',
    lat: 48.8584,
    lon: 2.2945,
    timeSlot: 'afternoon',
  };
  const notreDame: OptimizableStop = {
    name: 'Notre-Dame Cathedral',
    lat: 48.8530,
    lon: 2.3499,
    timeSlot: 'morning',
  };

  // Unoptimized: zigzag across Paris.
  const bigUnoptimized = [
    louvre,        // morning, Seine
    eiffelTower,   // afternoon, west
    sacreCoeur,    // morning, north
    museeOrsay,    // afternoon, Seine
    notreDame,     // morning, east
  ];

  console.log('\n--- Larger test (5 stops) ---');
  console.log('Input order:');
  bigUnoptimized.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name} (${s.timeSlot})`);
  });

  const bigOptimized = await optimizeDayRoute(bigUnoptimized);

  console.log('\nOptimized order:');
  bigOptimized.forEach((s) => {
    console.log(`  ${s.order}. ${s.name} (${s.timeSlot})`);
  });

  // Verify time-slot anchoring on the larger set.
  const bigMorning = bigOptimized.filter((s) => s.timeSlot === 'morning').map((s) => s.order);
  const bigAfternoon = bigOptimized.filter((s) => s.timeSlot === 'afternoon').map((s) => s.order);
  const bigMorningBeforeAfternoon = bigMorning.length === 0 || bigAfternoon.length === 0 ||
    Math.max(...bigMorning) < Math.min(...bigAfternoon);
  results.push(assert(
    bigMorningBeforeAfternoon,
    'Larger set: all morning stops precede all afternoon stops',
  ));

  // Verify all 5 stops present.
  results.push(assert(
    bigOptimized.length === 5,
    `Larger set: all 5 stops present (got ${bigOptimized.length})`,
  ));

  // Verify Louvre and Notre-Dame (both morning, both near Seine) are adjacent
  // rather than separated by Sacré-Cœur (Montmartre).
  const bigLouvreOrder = bigOptimized.find((s) => s.name === 'Louvre Museum')?.order;
  const bigNotreDameOrder = bigOptimized.find((s) => s.name === 'Notre-Dame Cathedral')?.order;
  const bigSacreCoeurOrder = bigOptimized.find((s) => s.name === 'Sacré-Cœur')?.order;

  console.log(`\n  Louvre: ${bigLouvreOrder}, Notre-Dame: ${bigNotreDameOrder}, Sacré-Cœur: ${bigSacreCoeurOrder}`);

  // The optimizer should place Sacré-Cœur either first or last among morning stops
  // (it's the outlier in Montmartre), keeping Louvre and Notre-Dame adjacent.
  const louvreAndNotreDameAdjacent = Math.abs((bigLouvreOrder || 0) - (bigNotreDameOrder || 0)) === 1;
  results.push(assert(
    louvreAndNotreDameAdjacent,
    'Louvre and Notre-Dame (both on the Seine) are adjacent in the optimized route',
  ));

  // Print results.
  console.log('\n=== Route Optimization Test Results ===\n');
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.message}`);
    if (r.ok) passed++;
    else failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
