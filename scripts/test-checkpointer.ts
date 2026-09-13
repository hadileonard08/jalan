/**
 * Test: LangGraph Postgres checkpointer.
 *
 * Verifies the two things that make checkpointing safe here:
 *  - durable state (currentItinerary, previousItineraries) survives between runs
 *    on the same thread_id, so a paused run resumes with its state
 *  - per-run state cannot leak into the next turn, because every run clears it
 *
 * Uses a small probe graph against the real checkpointer — no LLM calls.
 *
 * Usage:
 *   npx tsx scripts/test-checkpointer.ts
 */

import 'dotenv/config';
import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { Pool } from 'pg';
import {
  ConversationStateAnnotation,
  PER_RUN_STATE_RESET,
  DURABLE_STATE_KEYS,
} from '../src/agents/conversation-graph';
import { getCheckpointer, closeCheckpointer } from '../src/agents/checkpointer';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const ProbeAnnotation = Annotation.Root({
  durable: Annotation<string>({ reducer: (_c, next) => next, default: () => '' }),
  perRun: Annotation<string>({ reducer: (_c, next) => next, default: () => '' }),
});

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: LangGraph Postgres checkpointer');
  console.log('═══════════════════════════════════════════════════════════\n');

  const checkpointer = getCheckpointer();
  if (!checkpointer) {
    console.log('  ⚠️  DATABASE_URL not set — cannot exercise the checkpointer.');
    process.exit(1);
  }

  // --- 1. Every state key is consciously classified -------------------------
  console.log('Reset coverage (so a new state field cannot leak by accident):');
  const allKeys = Object.keys((ConversationStateAnnotation as any).spec);
  const perRunKeys = new Set(Object.keys(PER_RUN_STATE_RESET));
  const durableKeys = new Set(DURABLE_STATE_KEYS);
  const unclassified = allKeys.filter((k) => !perRunKeys.has(k) && !durableKeys.has(k));
  check(`all ${allKeys.length} state keys are either reset or durable`, unclassified, []);
  const overlap = [...perRunKeys].filter((k) => durableKeys.has(k));
  check('no key is both reset and durable', overlap, []);

  // --- 2. Live behaviour against the real checkpointer ----------------------
  const probe = new StateGraph(ProbeAnnotation)
    .addNode('step', () => ({ perRun: '' }))
    .addEdge(START, 'step')
    .addEdge('step', END)
    .compile({ checkpointer });

  const threadA = `test-thread-a-${Date.now()}`;
  const threadB = `test-thread-b-${Date.now()}`;

  console.log('\nSame thread, two runs:');
  const first = await probe.invoke(
    { durable: 'trip-A', perRun: 'leftover' },
    { configurable: { thread_id: threadA } }
  );
  check('run 1 keeps its durable value', first.durable, 'trip-A');
  check('run 1 clears the per-run value', first.perRun, '');

  const second = await probe.invoke(
    { perRun: 'stale-from-previous-turn' },
    { configurable: { thread_id: threadA } }
  );
  check('run 2 resumes with the persisted durable value', second.durable, 'trip-A');
  check('run 2 cannot inherit a stale per-run value', second.perRun, '');

  console.log('\nDifferent thread:');
  const otherThread = await probe.invoke({}, { configurable: { thread_id: threadB } });
  check('a fresh thread starts clean', otherThread.durable, '');

  console.log('\nMissing thread_id:');
  let threw = false;
  try {
    await probe.invoke({}, {});
  } catch {
    threw = true;
  }
  check('invoking without thread_id fails loudly', threw, true);

  // --- Cleanup -------------------------------------------------------------
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  for (const thread of [threadA, threadB]) {
    await pool.query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [thread]);
    await pool.query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [thread]);
    await pool.query('DELETE FROM checkpoints WHERE thread_id = $1', [thread]);
  }
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM checkpoints WHERE thread_id = ANY($1)',
    [[threadA, threadB]]
  );
  console.log(`\nCleaned up test threads (rows left: ${rows[0].n}).`);
  await pool.end();
  await closeCheckpointer();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
