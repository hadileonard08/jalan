import { db } from '../db';
import { savedTrips, tripProposals } from '../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

// Concurrency guards for the review path.
//
// Two reviewers can act at the same time. Without these, both requests pass a
// `status === 'pending'` check and both write the payload — the same suggestion
// gets applied twice, and one reviewer's itinerary change is silently lost.

type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * Atomically moves a proposal to a new status.
 *
 * The status transition is the lock: Postgres serialises the UPDATEs, so exactly
 * one caller matches the expected `from` status. Returns the updated row, or null
 * when someone else got there first.
 *
 * `from` includes 'rejected' when the Master Planner changes their mind and
 * accepts something they previously turned down.
 */
export async function claimProposal(
  tripId: string,
  proposalId: string,
  status: 'accepted' | 'rejected',
  from: ProposalStatus[] = ['pending'],
) {
  const [row] = await db
    .update(tripProposals)
    .set({ status, reviewedAt: new Date() })
    .where(
      and(
        eq(tripProposals.id, proposalId),
        eq(tripProposals.tripId, tripId),
        inArray(tripProposals.status, from),
      ),
    )
    .returning();
  return row || null;
}

/**
 * Puts a proposal back when the itinerary write lost a race, restoring whatever
 * it was before the claim (pending, or rejected if it was being re-accepted).
 */
export async function releaseProposal(
  proposalId: string,
  status: Exclude<ProposalStatus, 'accepted'> = 'pending',
) {
  await db
    .update(tripProposals)
    .set({ status, reviewedAt: null })
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
