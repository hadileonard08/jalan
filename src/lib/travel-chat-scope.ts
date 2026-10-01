export const OFF_TOPIC_TRAVEL_REPLY =
  'I can help with this trip, including places, timing, routes, costs, and itinerary changes. I can’t help with unrelated questions here.';

// Reject obvious non-travel requests before an LLM call. This intentionally stays
// narrow: words such as "code", "language", or "class" can be legitimate travel
// questions (dress code, local language, cabin class).
const OFF_TOPIC_PATTERNS: RegExp[] = [
  /\bleet\s*code\b/i,
  /\bhacker\s*rank\b/i,
  /\bcodeforces\b/i,
  /\bsolve\s+(?:this\s+)?(?:coding|programming|algorithm|data structure|math|calculus|algebra|homework)\s+(?:problem|question|challenge)/i,
  /\b(?:write|debug|refactor|compile|implement)\b[^\n]{0,60}\b(?:code|program|function|class|algorithm|sql query|regex)\b/i,
  /\btime complexity\b|\bspace complexity\b|\bbig[- ]?o\b/i,
  /\b(?:binary tree|linked list|dynamic programming|breadth[- ]first search|depth[- ]first search)\b/i,
  /```(?:\w+)?\s*[\s\S]*```/,
];

export function isObviouslyOffTopicTravelRequest(message: string): boolean {
  const normalized = message.trim();
  return normalized.length > 0 && OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(normalized));
}
