import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// LangGraph checkpointer: persists graph state per thread_id so a run can pause
// at END and resume with the same state on the next request.
//
// The saver talks to Postgres over TCP via `pg`, which is why `pg` and this
// package are listed as server externals in next.config.js. The pool is capped
// at a single connection so serverless invocations stay cheap.
//
// Returns null when DATABASE_URL is missing (e.g. local scripts) so the graph
// still runs — just without persistence.

let cached: PostgresSaver | null | undefined;
let cachedPool: Pool | null = null;

export function getCheckpointer(): PostgresSaver | null {
  if (cached !== undefined) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    cached = null;
    return cached;
  }

  try {
    cachedPool = new Pool({ connectionString, max: 1 });
    cached = new PostgresSaver(cachedPool);
  } catch (error) {
    console.error('Failed to create Postgres checkpointer:', error);
    cached = null;
  }

  return cached;
}

// One-time setup — creates the checkpoint tables. Run via
// `npx tsx scripts/setup-checkpointer.ts`, never in the request path.
export async function setupCheckpointer(): Promise<PostgresSaver> {
  const saver = getCheckpointer();
  if (!saver) throw new Error('DATABASE_URL is not set — cannot set up the checkpointer.');
  await saver.setup();
  return saver;
}

// Releases the pool (used by scripts so the process can exit).
export async function closeCheckpointer(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cached = undefined;
  }
}
