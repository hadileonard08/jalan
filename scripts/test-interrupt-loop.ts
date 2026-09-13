/**
 * Test: LangGraph interrupt() + resume — the mechanics the clarification loop
 * relies on.
 *
 * Proves, against the real Postgres checkpointer and with no LLM calls:
 *  - a node can suspend the run mid-graph (state is paused, not finished)
 *  - the pending interrupt is readable from the checkpoint
 *  - Command({ resume, update }) continues from the interrupted node
 *  - work done BEFORE interrupt() is not repeated on resume
 *
 * Usage:
 *   npx tsx scripts/test-interrupt-loop.ts
 */

import 'dotenv/config';
import { StateGraph, START, END, Annotation, Command, interrupt } from '@langchain/langgraph';
import { Pool } from 'pg';
import { getCheckpointer, closeCheckpointer } from '../src/agents/checkpointer';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const ProbeAnnotation = Annotation.Root({
  runs: Annotation<string[]>({ reducer: (curr, next) => [...curr, ...next], default: () => [] }),
  question: Annotation<string>({ reducer: (_c, next) => next, default: () => '' }),
  answer: Annotation<string>({ reducer: (_c, next) => next, default: () => '' }),
  history: Annotation<string[]>({ reducer: (_c, next) => next, default: () => [] }),
});

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: interrupt() + resume mechanics');
  console.log('═══════════════════════════════════════════════════════════\n');

  const checkpointer = getCheckpointer();
  if (!checkpointer) {
    console.log('  ⚠️  DATABASE_URL not set — cannot exercise the checkpointer.');
    process.exit(1);
  }

  const graph = new StateGraph(ProbeAnnotation)
    // Stand-in for clarifyAsk: the "expensive" node that must not re-run.
    .addNode('ask', () => ({ runs: ['ask'], question: 'Where to?' }))
    // Stand-in for clarify: suspends and waits for the user.
    .addNode('wait', (state) => {
      const reply = interrupt({ question: state.question });
      return { runs: ['wait'], answer: String(reply) };
    })
    .addEdge(START, 'ask')
    .addEdge('ask', 'wait')
    .addEdge('wait', END)
    .compile({ checkpointer });

  const thread = `test-interrupt-${Date.now()}`;
  const config = { configurable: { thread_id: thread } };

  // --- Run 1: should suspend, not finish -----------------------------------
  console.log('Run 1 — asking:');
  for await (const _ of await graph.stream({ history: ['user: hi'] }, { ...config, streamMode: 'updates' })) { /* drain */ }

  const paused: any = await graph.getState(config);
  check('run is suspended (not finished)', paused.next.length > 0, true);
  check('next node is the waiter', paused.next[0], 'wait');
  check('question was produced before suspending', paused.values.question, 'Where to?');
  check('the pending interrupt carries the question', paused.tasks?.[0]?.interrupts?.[0]?.value?.question, 'Where to?');

  // --- Run 2: resume with the user's reply ---------------------------------
  console.log('\nRun 2 — resuming with the answer:');
  for await (const _ of await graph.stream(
    new Command({ resume: 'Tokyo', update: { history: ['user: hi', 'ai: Where to?', 'user: Tokyo'] } }),
    { ...config, streamMode: 'updates' }
  )) { /* drain */ }

  const done: any = await graph.getState(config);
  check('run finished after resuming', done.next.length, 0);
  check('the reply reached the interrupted node', done.values.answer, 'Tokyo');
  check('the pre-interrupt node did NOT re-run', done.values.runs, ['ask', 'wait']);
  check('Command update was applied to state', done.values.history, ['user: hi', 'ai: Where to?', 'user: Tokyo']);

  // --- Cleanup -------------------------------------------------------------
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await pool.query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [thread]);
  await pool.query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [thread]);
  await pool.query('DELETE FROM checkpoints WHERE thread_id = $1', [thread]);
  console.log('\nCleaned up test thread.');
  await pool.end();
  await closeCheckpointer();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
