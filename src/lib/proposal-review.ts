import { db } from '../db';
import { savedTrips, tripProposals } from '../db/schema';
import { and, eq, sql } from 'drizzle-orm';

// Concurrency guards for the review path.
//
// Two reviewers can act at the same time. Without these, both requests pass a
// `status === 'pending'` check and both write the payload — the same suggestion
// gets applied twice, and one reviewer's itinerary change is silently lost.

/**
 * Atomically moves a proposal out of `pending`.
 *
 * The status transition is the lock: Postgres serialises the two UPDATEs, so
 * exactly one of them matches `status = 'pending'`. Returns the updated row, or
 * null when another reviewer got there first.
 */
export async function claimProposal(
  tripId: string,
  proposalId: string,
  status: 'accepted' | 'rejected',
) {
  const [row] = await db
    .update(tripProposals)
    .set({ status })
    .where(
      and(
        eq(tripProposals.id, proposalId),
        eq(tripProposals.tripId, tripId),
        eq(tripProposals.status, 'pending'),
      ),
    )
    .returning();
  return row || null;
}

/** Puts a proposal back when the itinerary write lost a race. */
export async function releaseProposal(proposalId: string) {
  await db
    .update(tripProposals)
    .set({ status: 'pending' })
    .where(and(eq(tripProposals.id, proposalId), eq(tripProposals.status, 'accepted')));
}

/**
 * Compare-and-swap the itinerary payload.
 *
 * Returns the updated trip, or null when the row's version no longer matches
 * what the caller read — i.e. someone else committed first. The caller should
 * release its claim and ask the user to retry, rather than overwriting.
 */
export async function commitPayload(tripId: string, expectedVersion: number, payload: unknown) {
  const [row] = await db
    .update(savedTrips)
    .set({
      payload: JSON.stringify(payload),
      version: sql`${savedTrips.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(savedTrips.id, tripId), eq(savedTrips.version, expectedVersion)))
    .returning();
  return row || null;
}
