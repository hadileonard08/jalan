import type { DayComment, DayFeedback, TripProposal } from './chat-state';

// One chronological timeline for a trip's collaboration panel.
//
// Comments and AI proposals live in different places — comments inside
// `saved_trips.payload.dayFeedback`, proposals in the `trip_proposals` table —
// so the panel used to show them in two separate lists. Merging them here (and
// sorting ascending) is what lets the UI read as one conversation.

export interface FeedItem {
  id: string;
  type: 'comment' | 'proposal';
  /** What to render: the comment text, or the AI's one-line summary. */
  content: string;
  author: string;
  createdAt: string;
  /** Day the item belongs to; null when a proposal targets no day. */
  day: number | null;
  /** The original record, for actions (accept/reject/edit/withdraw). */
  data: { comment?: DayComment; proposal?: TripProposal };
}

/** Days a proposal touches — a patch can span more than one. */
export function proposalDays(proposal: TripProposal): number[] {
  const days = new Set<number>();
  for (const edit of proposal.patchData?.edits || []) {
    if (Number.isInteger(edit.dayNumber) && edit.dayNumber > 0) days.add(edit.dayNumber);
  }
  return [...days];
}

export function buildTripFeed({
  dayFeedback,
  proposals,
  day,
}: {
  dayFeedback?: Record<string, DayFeedback>;
  proposals: TripProposal[];
  /** Restrict to one day. Omit for the whole trip. */
  day?: number;
}): FeedItem[] {
  const items: FeedItem[] = [];

  for (const [dayKey, feedback] of Object.entries(dayFeedback || {})) {
    const dayNumber = Number(dayKey);
    if (day !== undefined && dayNumber !== day) continue;
    for (const comment of feedback?.comments || []) {
      items.push({
        id: comment.id,
        type: 'comment',
        content: comment.text,
        author: comment.author,
        createdAt: comment.createdAt,
        day: dayNumber,
        data: { comment },
      });
    }
  }

  for (const proposal of proposals) {
    const days = proposalDays(proposal);
    if (day !== undefined && !days.includes(day)) continue;
    items.push({
      id: proposal.id,
      type: 'proposal',
      // The AI's conversational summary is what belongs in a chat bubble; the
      // prompt is the human's input and is carried on the proposal record.
      content: proposal.summary || proposal.suggestedPrompt,
      author: proposal.proposedByUserId,
      createdAt: proposal.createdAt,
      day: days.length === 1 ? days[0] : null,
      data: { proposal },
    });
  }

  // Ascending, so the panel reads top-to-bottom as a conversation. Ties fall back
  // to id so the order is stable across renders.
  return items.sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}
