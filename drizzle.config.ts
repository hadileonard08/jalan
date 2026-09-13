import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // The LangGraph checkpointer owns these tables (created by
  // `scripts/setup-checkpointer.ts`, not by Drizzle). Without this filter,
  // `drizzle-kit push` treats them as unknown tables and offers to DROP them —
  // which would wipe every conversation's thread state.
  tablesFilter: ['!checkpoint*'],
} satisfies Config;
