/**
 * One-time setup for the LangGraph Postgres checkpointer.
 *
 * Creates the checkpoint tables (checkpoints, checkpoint_blobs,
 * checkpoint_writes, checkpoint_migrations). Safe to re-run — it only applies
 * missing migrations.
 *
 * Usage:
 *   npx tsx scripts/setup-checkpointer.ts
 */

import 'dotenv/config';
import { setupCheckpointer, closeCheckpointer } from '../src/agents/checkpointer';

async function main() {
  await setupCheckpointer();
  console.log('Checkpointer tables are ready.');
  await closeCheckpointer();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
