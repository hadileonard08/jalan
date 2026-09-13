/**
 * Test: Clarify loop guard.
 *
 * The graph runs statelessly per request, so the clarification streak is
 * derived from persisted history instead of a checkpointer. This verifies:
 * - the streak counter survives across turns and resets when the trip is planned
 * - the router stops asking after MAX_CLARIFICATIONS and falls back gracefully
 *
 * No Gemini tokens are consumed — no LLM is called.
 *
 * Usage:
 *   npx tsx scripts/test-clarify-loop.ts
 */

import { conversationGraph, countTrailingClarifications, nextClarifyRoute } from '../src/agents/conversation-graph';
import type { PersistedMessage } from '../src/lib/chat-state';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const ask = (text = 'Which city?'): PersistedMessage => ({
  role: 'assistant',
  content: text,
  payload: { clarification: true },
});
const reply = (text = 'hmm'): PersistedMessage => ({ role: 'user', content: text });
const plan = (): PersistedMessage => ({
  role: 'assistant',
  content: 'Here is your itinerary',
  payload: { itinerary: '## Day 1', entities: { destination: 'Tokyo' } },
});

function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: Clarify loop guard');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Streak counting:');
  check('empty history', countTrailingClarifications([]), 0);
  check('one question asked', countTrailingClarifications([ask()]), 1);
  check('two in a row', countTrailingClarifications([ask(), reply(), ask()]), 2);
  check('three in a row', countTrailingClarifications([ask(), reply(), ask(), reply(), ask()]), 3);
  check('reply not yet answered (trailing user msg)', countTrailingClarifications([ask(), reply()]), 1);
  check('streak broken by an itinerary', countTrailingClarifications([ask(), reply(), plan()]), 0);
  check('streak broken by a normal answer', countTrailingClarifications([ask(), reply(), { role: 'assistant', content: 'Sure!' }]), 0);
  check('legacy messages without the marker', countTrailingClarifications([{ role: 'assistant', content: 'Which city?' }]), 0);
  check('questions before a plan do not carry over', countTrailingClarifications([ask(), ask(), plan(), reply()]), 0);

  console.log('\nRouter decision (limit = 3):');
  check('0 asked -> ask', nextClarifyRoute(0), 'clarify');
  check('1 asked -> ask', nextClarifyRoute(1), 'clarify');
  check('2 asked -> ask', nextClarifyRoute(2), 'clarify');
  check('3 asked -> stop and fall back', nextClarifyRoute(3), 'clarifyLimit');
  check('4 asked -> stay on the fallback', nextClarifyRoute(4), 'clarifyLimit');

  console.log('\nSimulated vague conversation (user never gives a destination):');
  const history: PersistedMessage[] = [];
  const routes: string[] = [];
  let streakAfterFallback = -1;
  for (let turn = 0; turn < 4; turn++) {
    const count = countTrailingClarifications(history);
    const route = nextClarifyRoute(count);
    routes.push(route);
    if (route === 'clarify') {
      history.push(ask(`Question ${turn + 1}`), reply('something vague'));
    } else {
      history.push({ role: 'assistant', content: 'Let me suggest some options instead.' });
      streakAfterFallback = countTrailingClarifications(history);
    }
  }
  console.log(`  routes: ${routes.join(' -> ')}`);
  check('asks 3 times then falls back', routes, ['clarify', 'clarify', 'clarify', 'clarifyLimit']);
  check('fallback resets the streak for a fresh attempt', streakAfterFallback, 0);

  console.log('\nStreak resets once the trip is actually planned:');
  check(
    'planning after 2 questions clears the count',
    countTrailingClarifications([ask(), reply(), ask(), reply(), plan(), reply(), plan()]),
    0
  );

  // Structural guarantees: a reply to a clarification re-enters Extract because
  // every run starts there, and Clarify/ClarifyLimit both end the run (pause).
  console.log('\nGraph wiring:');
  const graph = (conversationGraph as any).getGraph();
  const hasEdge = (source: string, target: string) =>
    graph.edges.some((e: any) => e.source === source && e.target === target);

  check('START -> Extract (every turn re-enters Extract)', hasEdge('__start__', 'extract'), true);
  check('Extract can branch to Clarify', hasEdge('extract', 'clarify'), true);
  check('Extract can branch to ClarifyLimit', hasEdge('extract', 'clarifyLimit'), true);
  check('Clarify ends the run (state pauses)', hasEdge('clarify', '__end__'), true);
  check('ClarifyLimit ends the run', hasEdge('clarifyLimit', '__end__'), true);
  check('Gather -> Generate (planning clears the streak)', hasEdge('gather', 'generate'), true);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

run();
