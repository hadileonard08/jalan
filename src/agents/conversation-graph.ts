import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { getChatModel, getQualityModel } from '../lib/ai-provider';
import { getWeatherForecast } from './weather';
import { searchDestinationNews } from './news-search';
import { getDestinationImageUrl, hydrateItineraryImages } from './destination-images';
import { verifyItineraryLandmarks, buildRouteLinks } from './itinerary-guardrails';
import { buildTransportPlan, injectTransportNotes } from './transport';
import { applyRefinements, extractExistingItinerary } from './refine-itinerary';
import { getCheckpointer } from './checkpointer';
import { db } from '../db';
import { flights, deals } from '../db/schema';
import { eq, gte, lte, inArray, and, sql } from 'drizzle-orm';
import * as chrono from 'chrono-node';
import { searchSeatsAeroLive } from '../lib/seatsaero';
import { getAirlineBookingUrl } from '../lib/airline-booking';
import { CITY_MAP } from '../lib/city-map';
import type {
  ExtractedEntities,
  ClarifyingQuestion,
  PersistedMessage,
  RouteLink,
  UserPreferences,
} from '../lib/chat-state';
import { evaluateRag, type RagEvaluation } from '../lib/ragEvaluator';

const llm = getChatModel(0.4);
const qualityLlm = getQualityModel(0.4);

const COMPANION_PERSONA = `You are Jalan, a friendly travel companion. You are warm, curious, and helpful — like a friend who loves planning trips. Use a conversational tone, ask one or two follow-up questions when needed, and avoid sounding robotic or overly formal. Keep responses concise but useful.`;

const DEFAULT_TRIP_DAYS = 5;
const MAX_TRIP_DAYS = 30; // Guardrail: cap itineraries at 30 days
const MAX_CLARIFICATIONS = 3; // Guardrail: consecutive questions before we stop asking

// The graph runs statelessly per request, so the clarification streak is
// derived from persisted history rather than a checkpointer: an assistant
// message marked as a clarification continues the streak, anything else ends it.
export function countTrailingClarifications(history: PersistedMessage[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== 'assistant') continue;
    if (message.payload?.clarification) count++;
    else break;
  }
  return count;
}

type RetrievedDeal = Awaited<ReturnType<typeof getRelevantDeals>>[number];
type TransportPlan = Awaited<ReturnType<typeof buildTransportPlan>>;

export const ConversationStateAnnotation = Annotation.Root({
  userMessage: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  userQuery: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  retrievedContext: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  draftItinerary: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  dateValidationError: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  currentItinerary: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  previousItineraries: Annotation<string[]>({ reducer: (_curr, next) => next, default: () => [] }),
  history: Annotation<PersistedMessage[]>({ reducer: (_curr, next) => next, default: () => [] }),
  entities: Annotation<ExtractedEntities>({ reducer: (_curr, next) => next, default: () => ({}) }),
  userPreferences: Annotation<UserPreferences | null>({ reducer: (_curr, next) => next, default: () => null }),
  missingFields: Annotation<string[]>({ reducer: (_curr, next) => next, default: () => [] }),
  clarificationCount: Annotation<number>({ reducer: (_curr, next) => next, default: () => 0 }),
  questions: Annotation<ClarifyingQuestion[]>({ reducer: (_curr, next) => next, default: () => [] }),
  weather: Annotation<unknown | null>({ reducer: (_curr, next) => next, default: () => null }),
  news: Annotation<string | null>({ reducer: (_curr, next) => next, default: () => null }),
  deals: Annotation<RetrievedDeal[]>({ reducer: (_curr, next) => next, default: () => [] }),
  images: Annotation<Record<string, string>>({ reducer: (_curr, next) => next, default: () => ({}) }),
  itinerary: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  routeLinks: Annotation<RouteLink[]>({ reducer: (_curr, next) => next, default: () => [] }),
  transportPlan: Annotation<TransportPlan | null>({ reducer: (_curr, next) => next, default: () => null }),
  packingTips: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  criticFeedback: Annotation<string[]>({ reducer: (_curr, next) => next, default: () => [] }),
  isApproved: Annotation<boolean>({ reducer: (_curr, next) => next, default: () => false }),
  revisionCount: Annotation<number>({ reducer: (_curr, next) => next, default: () => 0 }),
  finalResponse: Annotation<string>({ reducer: (_curr, next) => next, default: () => '' }),
  ragEvaluation: Annotation<RagEvaluation | null>({ reducer: (_curr, next) => next, default: () => null }),
});

const REQUIRED_FIELDS = ['destination', 'startDate'];

// Fields that belong to ONE run. Because the graph is checkpointed per thread,
// state now survives between turns — so these are cleared at the top of every
// run. Without this, a stale `revisionCount` could make the critic reject a new
// itinerary without retrying, or `isApproved`/`criticFeedback` could carry over
// from a previous trip.
//
// Deliberately NOT reset (durable across turns): currentItinerary,
// previousItineraries, and everything the caller supplies each request
// (userMessage, history, userPreferences).
export const PER_RUN_STATE_RESET: Partial<typeof ConversationStateAnnotation.State> = {
  draftItinerary: '',
  retrievedContext: '',
  itinerary: '',
  weather: null,
  news: null,
  deals: [],
  images: {},
  routeLinks: [],
  transportPlan: null,
  packingTips: '',
  criticFeedback: [],
  isApproved: false,
  revisionCount: 0,
  finalResponse: '',
  ragEvaluation: null,
  questions: [],
};

// State keys that must survive between turns (plus the per-request inputs).
// The clarify-loop test asserts every annotation key is accounted for here or
// in PER_RUN_STATE_RESET, so a new field can't be added without deciding.
export const DURABLE_STATE_KEYS = [
  'userMessage',
  'userQuery',
  'history',
  'entities',
  'userPreferences',
  'missingFields',
  'clarificationCount',
  'dateValidationError',
  'currentItinerary',
  'previousItineraries',
];

async function parseJsonResponse(raw: string) {
  const text = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/\n/g, ' '));
    } catch {
      return null;
    }
  }
}

async function extractNode(state: typeof ConversationStateAnnotation.State) {
  if (!llm) throw new Error('AI provider not configured');

  const historyText = state.history
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  // Determine whether a previous itinerary exists so the router can treat
  // follow-up tweaks as a `refine` intent.
  const hasExistingItinerary =
    state.currentItinerary?.length > 200 ||
    state.history.some(
      (m) => m.role === 'assistant' && (m.payload?.itinerary || m.content.length > 200)
    );

  const prompt = `${COMPANION_PERSONA}

You are also a detail extractor. Read the conversation and figure out the user's intent and trip details.
Today is ${new Date().toISOString().split('T')[0]}.

**Itinerary already exists in this conversation:** ${hasExistingItinerary ? 'YES' : 'NO'}

Instructions:
- If the user gives a month or date WITHOUT a year, resolve it to the next occurrence that is today or later.
- If the user gives an EXPLICIT year (e.g. "October 1, 2023"), preserve that year exactly as written. Do NOT silently change a past year to a future year — the system will reject past dates separately.
- Use the conversation history for context. If the user is answering a previous clarifying question, combine it with earlier messages.
- Required: destination, and either a specific startDate OR a general/relative date expression (e.g. "October", "in two weeks", "flexible", "2 week trip").
- If the user only gives a duration ("2 week trip") or a rough window without an exact date, set durationDays and datesGeneral, and leave startDate null.
- If the user says "flexible" or similar, set datesGeneral to "flexible" and leave startDate null.
- Do not mark startDate as missing if datesGeneral or durationDays is provided.
- intent values:
  - plan_trip: user wants a new itinerary or help planning a trip (e.g. "Plan a trip to Tokyo", "I want to go to Seoul for 2 weeks")
  - ask_question: user is asking a specific question OR looking for deals without a full itinerary (e.g. "When is the best time to visit Japan?", "find any deal to Tokyo in December", "show me cheap flights to Bangkok", "what's the weather like?")
  - refine: user wants to change something about an earlier plan (e.g. "swap day 2 lunch for a vegan spot", "make it shorter", "I don't drink beer", "replace the brewery with a museum")
  - greeting: user just said hi or similar
  - vague: user's message is too vague to act on — no destination, no dates, no clear question (e.g. "I want to travel", "help me", "trips", "something fun")

**CRITICAL refine rules (only when hasExistingItinerary === YES):**
- If an itinerary already exists and the user asks to change, tweak, swap, or modify a specific day, meal, activity, or stop, you MUST classify the intent as "refine".
- Do NOT classify tweaks as "plan_trip" or "ask_question".
- Messages like "make it cheaper", "make it shorter", "swap day 2", "replace the brewery", "I don't drink beer", "add more museums", or "remove the shopping" are ALL "refine".
- If the intent is "refine", also set "refinementInstructions" to the exact user request text, so the delta-update agent can apply it.

Optional fields: origin, endDate, cabin (ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST), travelers, budget, interests, refinementInstructions.

The "interests" field should capture any specific themes, activities, or preferences the user mentioned — e.g. "football", "food and nightlife", "art museums", "hiking and nature", "anime and gaming", "history and architecture", "shopping". This is free-form text, not an enum. If the user didn't mention any specific interests, leave it null.

Respond ONLY in JSON:
{
  "entities": {
    "destination": "city or country",
    "destinationCode": "3-letter IATA airport code (e.g. NRT, HND, LHR) — if the user says a country like 'Japan', pick the main airport code (e.g. NRT for Tokyo)",
    "origin": "home city",
    "originCode": "IATA city code if known",
    "startDate": "YYYY-MM-DD or null",
    "endDate": "YYYY-MM-DD or null",
    "datesGeneral": "e.g. November, in two weeks, flexible, or null",
    "durationDays": 14,
    "cabin": "ECONOMY or null",
    "travelers": 2,
    "budget": "string or null",
    "interests": "football, stadium tours" or null,
    "intent": "plan_trip | ask_question | refine | greeting | vague",
    "refinementInstructions": "exact user request for refine intent, or null"
  },
  "missingFields": ["field1", "field2"]
}

History:
${historyText}

User: ${state.userMessage}
`;

  const res = await llm.invoke(prompt);
  const parsed = await parseJsonResponse(res.content as string);
  const entities: ExtractedEntities = parsed?.entities || {};
  const missingFields: string[] = (parsed?.missingFields || []).filter((f: string) =>
    REQUIRED_FIELDS.includes(f)
  );

  // If only a general/relative date was provided, try to resolve it
  if (entities.datesGeneral && !entities.startDate) {
    const parsed = parseGeneralDate(entities.datesGeneral, entities.durationDays);
    if (parsed.startDate) entities.startDate = parsed.startDate;
    if (parsed.endDate) entities.endDate = parsed.endDate;
    if (parsed.durationDays) entities.durationDays = parsed.durationDays;
  }

  // Deterministic past-date recovery: if the user's message contains explicit
  // dates with years (e.g. "October 1, 2025"), parse them with chrono. If the
  // LLM silently "corrected" a past year to a future year, restore the actual
  // past dates so the guardrail (getTravelDateValidationError) fires correctly.
  const explicitDateParse = chrono.parse(state.userMessage, new Date(), { forwardDate: false });
  if (explicitDateParse.length > 0) {
    const explicitStart = explicitDateParse[0].start.date();
    const explicitEnd = explicitDateParse[0].end?.date();
    const today = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ));
    // Only override if the explicitly parsed date is in the past AND the user's
    // message contained a 4-digit year (so we don't catch "October" alone).
    const hasExplicitYear = /\b(?:19|20)\d{2}\b/.test(state.userMessage);
    if (hasExplicitYear && explicitStart < today) {
      entities.startDate = explicitStart.toISOString().split('T')[0];
      if (explicitEnd) {
        entities.endDate = explicitEnd.toISOString().split('T')[0];
      }
    }
  }

  // Try parsing the raw user message for dates/duration as a fallback
  if (!entities.startDate) {
    const parsed = parseGeneralDate(state.userMessage, entities.durationDays);
    if (parsed.startDate) entities.startDate = parsed.startDate;
    if (parsed.endDate) entities.endDate = parsed.endDate;
    if (parsed.durationDays && !entities.durationDays) entities.durationDays = parsed.durationDays;
  }

  const normalizedDates = normalizeImplicitPastDateRange(
    entities.startDate,
    entities.endDate,
    `${historyText}\n${state.userMessage}`,
  );
  entities.startDate = normalizedDates.startDate;
  entities.endDate = normalizedDates.endDate;

  // If user mentioned duration (e.g. "2 week trip") but no endDate, compute it
  if (entities.durationDays && entities.startDate && !entities.endDate) {
    const start = new Date(entities.startDate);
    const end = new Date(start.getTime() + (entities.durationDays - 1) * 24 * 60 * 60 * 1000);
    entities.endDate = end.toISOString().split('T')[0];
  }

  // Guardrail: cap trip duration at MAX_TRIP_DAYS (30 days).
  // Prevents absurd requests like "2 years" from generating 730 days.
  if (entities.durationDays && entities.durationDays > MAX_TRIP_DAYS) {
    entities.durationDays = MAX_TRIP_DAYS;
    if (entities.startDate) {
      const start = new Date(entities.startDate);
      const end = new Date(start.getTime() + (MAX_TRIP_DAYS - 1) * 24 * 60 * 60 * 1000);
      entities.endDate = end.toISOString().split('T')[0];
    }
  }
  // Also cap if startDate + endDate span more than MAX_TRIP_DAYS
  if (entities.startDate && entities.endDate) {
    const start = new Date(entities.startDate);
    const end = new Date(entities.endDate);
    const spanDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > MAX_TRIP_DAYS) {
      const cappedEnd = new Date(start.getTime() + (MAX_TRIP_DAYS - 1) * 24 * 60 * 60 * 1000);
      entities.endDate = cappedEnd.toISOString().split('T')[0];
      if (!entities.durationDays) entities.durationDays = MAX_TRIP_DAYS;
    }
  }

  const dateValidationError = getTravelDateValidationError(entities.startDate, entities.endDate);

  // For trip planning requests, default to a flexible date soon if the user didn't specify one.
  // For question/deal lookups, leave the date missing so the agent asks for it.
  if (
    entities.destination &&
    !entities.startDate &&
    (entities.intent === 'plan_trip' || entities.intent === 'refine')
  ) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 60);
    entities.startDate = fallback.toISOString().split('T')[0];
    entities.datesGeneral = entities.datesGeneral || 'flexible';
    if (entities.durationDays) {
      const end = new Date(fallback.getTime() + (entities.durationDays - 1) * 24 * 60 * 60 * 1000);
      entities.endDate = end.toISOString().split('T')[0];
    }
  }

  // Seed currentItinerary from conversation history if the state doesn't
  // already have it. This lets refine/applyRefinements use the latest plan.
  const currentItinerary = state.currentItinerary || extractExistingItinerary(state.history);

  const stillMissing = REQUIRED_FIELDS.filter(
    (f) => !entities[f as keyof ExtractedEntities]
  );

  return {
    ...PER_RUN_STATE_RESET,
    userQuery: state.userMessage,
    entities,
    dateValidationError,
    missingFields: stillMissing.length ? stillMissing : missingFields,
    currentItinerary,
    // Seed the streak from prior turns so the loop guard survives requests.
    clarificationCount: countTrailingClarifications(state.history),
  };
}

function parseGeneralDate(general: string, durationDays?: number): { startDate?: string; endDate?: string; durationDays?: number } {
  const results = chrono.parse(general, new Date(), { forwardDate: true });
  if (results && results.length > 0) {
    const start = results[0].start.date();
    const duration = durationDays || inferDurationDays(general);
    const end = duration
      ? new Date(start.getTime() + (duration - 1) * 24 * 60 * 60 * 1000)
      : undefined;
    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end ? end.toISOString().split('T')[0] : undefined,
      durationDays: duration,
    };
  }

  // Fallback for month/year like "October 2026"
  const now = new Date();
  const match = general.match(/(\w+)\s*(\d{4})?/i);
  if (match) {
    const monthNames = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december'
    ];
    const month = monthNames.findIndex((m) => m === match[1].toLowerCase());
    if (month !== -1) {
      const year = parseInt(match[2] || String(now.getFullYear()), 10);
      const start = new Date(year, month, 15);
      const duration = durationDays || inferDurationDays(general) || 7;
      const end = new Date(start.getTime() + (duration - 1) * 24 * 60 * 60 * 1000);
      return {
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
        durationDays: duration,
      };
    }
  }

  return {};
}

export function normalizeImplicitPastDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  sourceText: string,
  referenceDate = new Date(),
): { startDate?: string; endDate?: string } {
  if (!startDate || /\b(?:19|20)\d{2}\b/.test(sourceText)) return { startDate, endDate };

  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return { startDate, endDate };

  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  if (start >= today) return { startDate, endDate };

  const end = endDate ? new Date(`${endDate}T00:00:00Z`) : undefined;
  const durationMs = end && !Number.isNaN(end.getTime()) ? end.getTime() - start.getTime() : undefined;
  while (start < today) start.setUTCFullYear(start.getUTCFullYear() + 1);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: durationMs === undefined
      ? endDate
      : new Date(start.getTime() + durationMs).toISOString().split('T')[0],
  };
}

export function getTravelDateValidationError(
  startDate: string | undefined,
  endDate: string | undefined,
  referenceDate = new Date(),
): string {
  if (!startDate) return '';

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = endDate ? new Date(`${endDate}T00:00:00Z`) : undefined;
  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) {
    return 'The travel dates are invalid. Please provide valid future dates.';
  }
  if (start < today || (end && end < today)) {
    return `Those travel dates are in the past. Please choose dates on or after ${today.toISOString().split('T')[0]}.`;
  }
  if (end && end < start) {
    return 'The return date must be on or after the departure date. Please provide a valid future date range.';
  }
  return '';
}

export function getExpectedTripDays(
  startDate: string | undefined,
  endDate: string | undefined,
  durationDays: number | undefined,
): number | undefined {
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
      return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    }
  }
  return durationDays && durationDays > 0 ? durationDays : undefined;
}

export function findPastCalendarDates(text: string, referenceDate = new Date()): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) candidates.add(match[0]);
  for (const match of text.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/gi)) {
    candidates.add(match[0]);
  }

  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  return [...candidates].filter((candidate) => {
    const parsed = /^\d{4}-/.test(candidate)
      ? new Date(`${candidate}T00:00:00Z`)
      : new Date(candidate);
    return !Number.isNaN(parsed.getTime()) && parsed < today;
  });
}

function inferDurationDays(text: string): number | undefined {
  const match = text.match(/(\d+)\s*(week|day|month)s?\s*(trip|long|duration)?/i);
  if (!match) return undefined;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'week') return amount * 7;
  if (unit === 'day') return amount;
  if (unit === 'month') return amount * 30;
  return undefined;
}

async function clarifyNode(state: typeof ConversationStateAnnotation.State) {
  if (!llm) throw new Error('AI provider not configured');
  // Each clarifying question advances the streak; the reply comes back into
  // Extract on the next turn, which re-seeds the count from history.
  const clarificationCount = state.clarificationCount + 1;

  if (state.dateValidationError) {
    return { questions: [], finalResponse: state.dateValidationError, clarificationCount };
  }

  const isVague = state.entities.intent === 'vague';
  const missing = state.missingFields.slice(0, 3);

  let prompt: string;
  if (isVague) {
    prompt = `${COMPANION_PERSONA}

The user said something vague — no clear destination, dates, or question. Be warm and curious. Ask a friendly follow-up to learn what kind of trip they're dreaming about. Give a few concrete examples to spark ideas (e.g. a beach weekend, a foodie city break, an adventure trip). Keep it short, conversational, and enthusiastic — like a friend who loves planning trips.

User's message: "${state.userMessage}"

Respond ONLY in plain text (no JSON, no markdown headers).`;
  } else {
    prompt = `${COMPANION_PERSONA}

The user is planning a trip but we are missing: ${missing.join(', ')}.
Ask ONE short, conversational clarifying question to get the missing info. Suggest a few example answers inline. Keep it friendly and brief. Do not list numbered questions.

Respond ONLY in plain text (no JSON, no markdown headers).`;
  }

  const res = await llm.invoke(prompt);
  const finalResponse = (res.content as string).trim() || 'I need a bit more info to plan your trip.';
  return { questions: [], finalResponse, clarificationCount };
}

// Loop guard: once we've asked MAX_CLARIFICATIONS questions in a row without
// getting anywhere, stop asking and hand the user a concrete way forward.
export function nextClarifyRoute(clarificationCount: number) {
  return clarificationCount >= MAX_CLARIFICATIONS ? 'clarifyLimit' : 'clarify';
}

function routeToClarify(state: typeof ConversationStateAnnotation.State) {
  return nextClarifyRoute(state.clarificationCount);
}

function routeAfterExtract(state: typeof ConversationStateAnnotation.State) {
  if (state.dateValidationError) return routeToClarify(state);
  if (state.entities.intent === 'greeting') return 'respond';
  if (state.entities.intent === 'vague') return routeToClarify(state);
  if (state.entities.intent === 'ask_question') {
    if (state.missingFields.length > 0) return routeToClarify(state);
    return 'answer';
  }
  // Refine intent: bypass Gather/Generate and go directly to the delta-update
  // node, which surgically edits the existing itinerary from history.
  if (state.entities.intent === 'refine' && state.entities.destination) return 'applyRefinements';
  if (state.missingFields.length > 0) return routeToClarify(state);
  return 'gather';
}

// Fallback after too many clarifying questions: be useful instead of looping.
function clarifyLimitNode(state: typeof ConversationStateAnnotation.State) {
  const missing = state.missingFields.length > 0 ? state.missingFields : ['destination', 'dates'];

  return {
    clarificationCount: 0,
    finalResponse: `I don't want to keep asking — let's just get moving.

I still need **${missing.join(' and ')}** to build a real itinerary. The quickest way is to say it in one line, for example:

- "5 days in Tokyo in October"
- "A long weekend in Lisbon, flexible dates"
- "Two weeks in Peru next June, mid-range budget"

If you'd rather browse first, tell me a region or a vibe (beaches, food, mountains) and I'll suggest where to go and when.`,
  };
}

async function gatherNode(state: typeof ConversationStateAnnotation.State) {
  if (!llm) throw new Error('AI provider not configured');
  const dateError = getTravelDateValidationError(state.entities.startDate, state.entities.endDate);
  if (dateError) throw new Error(`Past or invalid travel date reached Gather: ${dateError}`);

  const destination = state.entities.destination || '';
  const destinationCode = state.entities.destinationCode || destination;
  const originCode = state.entities.originCode || '';
  let startDate = state.entities.startDate ? new Date(state.entities.startDate) : undefined;
  let endDate = state.entities.endDate ? new Date(state.entities.endDate) : undefined;
  if (startDate && !endDate) {
    // Use durationDays if provided, otherwise default to 5 days
    const tripDays = state.entities.durationDays && state.entities.durationDays > 0
      ? state.entities.durationDays
      : DEFAULT_TRIP_DAYS;
    endDate = new Date(startDate.getTime() + (tripDays - 1) * 24 * 60 * 60 * 1000);
    state.entities.endDate = endDate.toISOString().split('T')[0];
  }
  const [weatherResult, newsResult, imageResult, dealsResult] = await Promise.all([
    getWeatherData(destinationCode, startDate, endDate, destination),
    startDate
      ? searchDestinationNews(destinationCode, startDate, endDate || startDate, destination, state.entities.interests || undefined).catch(() => null)
      : Promise.resolve(null),
    getDestinationImageUrl(destinationCode, destination).catch(() => null),
    getRelevantDeals(state.entities),
  ]);

  const images = { destination: imageResult || '' };
  return {
    // We finally have enough to plan, so the clarification streak is over.
    clarificationCount: 0,
    entities: endDate
      ? { ...state.entities, endDate: endDate.toISOString().split('T')[0] }
      : state.entities,
    weather: weatherResult,
    news: newsResult,
    deals: dealsResult,
    images,
    retrievedContext: JSON.stringify({
      entities: state.entities,
      weather: weatherResult,
      news: newsResult,
      deals: dealsResult,
      images,
    }),
  };
}

async function generateNode(state: typeof ConversationStateAnnotation.State) {
  const itineraryPromise = generateItinerary(state);
  const packingTipsPromise = state.packingTips
    ? Promise.resolve(state.packingTips)
    : generatePackingTips(state);
  const [itinerary, packingTips] = await Promise.all([itineraryPromise, packingTipsPromise]);

  // Preserve the previous itinerary before overwriting it.
  const previousItineraries = [...state.previousItineraries];
  if (state.currentItinerary && !previousItineraries.includes(state.currentItinerary)) {
    previousItineraries.push(state.currentItinerary);
  }

  return {
    retrievedContext: JSON.stringify({
      entities: state.entities,
      weather: state.weather,
      news: state.news,
      deals: state.deals,
      images: state.images,
    }),
    draftItinerary: itinerary,
    itinerary,
    currentItinerary: itinerary,
    previousItineraries,
    packingTips,
  };
}

async function enrichNode(state: typeof ConversationStateAnnotation.State) {
  const destination = state.entities.destination || '';
  const routeLinks = destination ? buildRouteLinks(state.itinerary, destination) : [];

  // Run transport and images concurrently — they are independent.
  const [transportPlan, itineraryWithImages] = await Promise.all([
    routeLinks.length > 0
      ? buildTransportPlan(routeLinks, destination, state.itinerary).catch(() => null)
      : Promise.resolve(null),
    hydrateItineraryImages(state.itinerary, destination).catch(() => state.itinerary),
  ]);

  // Update route links with optimized Google Maps URLs from the route optimizer.
  if (transportPlan?.days) {
    for (const day of transportPlan.days) {
      const link = routeLinks.find((rl) => rl.day === day.day);
      if (link && day.optimizedUrl) {
        link.url = day.optimizedUrl;
      }
    }
  }

  // Inject transport notes into the already-image-hydrated itinerary.
  const itinerary = transportPlan
    ? injectTransportNotes(itineraryWithImages, transportPlan)
    : itineraryWithImages;

  return { itinerary, routeLinks, transportPlan };
}

async function getWeatherData(
  destinationCode: string,
  startDate?: Date,
  endDate?: Date,
  destinationName?: string
): Promise<any> {
  if (!startDate) return null;
  const end = endDate || new Date(startDate.getTime() + 4 * 24 * 60 * 60 * 1000);
  try {
    return await getWeatherForecast(destinationCode, startDate, end, destinationName);
  } catch {
    return null;
  }
}

// Map a country name or 2-letter country code to all airport codes in CITY_MAP.
// e.g. "Japan" / "JP" -> ["HND", "NRT", "KIX"]
function resolveDestinationCodes(destinationCode: string, destinationName?: string): string[] {
  if (!destinationCode) return [];

  // If it's already a 3-letter IATA code, use it directly.
  if (destinationCode.length === 3 && destinationCode === destinationCode.toUpperCase()) {
    // Check if it's a known airport code
    if (CITY_MAP[destinationCode]) return [destinationCode];
  }

  // Try matching by country code (2-letter)
  if (destinationCode.length === 2) {
    const codes = Object.entries(CITY_MAP)
      .filter(([, info]) => info.countryCode === destinationCode.toUpperCase())
      .map(([code]) => code);
    if (codes.length > 0) return codes;
  }

  // Try matching by country name
  const countryMap: Record<string, string> = {
    'japan': 'JP', 'jp': 'JP', 'jpn': 'JP',
    'korea': 'KR', 'south korea': 'KR', 'kr': 'KR',
    'thailand': 'TH', 'th': 'TH',
    'singapore': 'SG', 'sg': 'SG',
    'indonesia': 'ID', 'id': 'ID',
    'india': 'IN', 'in': 'IN',
    'taiwan': 'TW', 'tw': 'TW',
    'hong kong': 'HK', 'hk': 'HK',
    'malaysia': 'MY', 'my': 'MY',
    'philippines': 'PH', 'ph': 'PH',
    'vietnam': 'VN', 'vn': 'VN',
    'uk': 'GB', 'united kingdom': 'GB', 'gb': 'GB', 'england': 'GB',
    'france': 'FR', 'fr': 'FR',
    'germany': 'DE', 'de': 'DE',
    'netherlands': 'NL', 'nl': 'NL',
    'spain': 'ES', 'es': 'ES',
    'italy': 'IT', 'it': 'IT',
    'switzerland': 'CH', 'ch': 'CH',
    'austria': 'AT', 'at': 'AT',
    'ireland': 'IE', 'ie': 'IE',
    'portugal': 'PT', 'pt': 'PT',
    'greece': 'GR', 'gr': 'GR',
    'czech': 'CZ', 'czechia': 'CZ', 'cz': 'CZ',
    'poland': 'PL', 'pl': 'PL',
    'denmark': 'DK', 'dk': 'DK',
    'sweden': 'SE', 'se': 'SE',
    'norway': 'NO', 'no': 'NO',
    'finland': 'FI', 'fi': 'FI',
    'turkey': 'TR', 'tr': 'TR',
    'uae': 'AE', 'united arab emirates': 'AE', 'ae': 'AE',
    'qatar': 'QA', 'qa': 'QA',
    'israel': 'IL', 'il': 'IL',
    'mexico': 'MX', 'mx': 'MX',
    'colombia': 'CO', 'co': 'CO',
    'peru': 'PE', 'pe': 'PE',
    'chile': 'CL', 'cl': 'CL',
    'argentina': 'AR', 'ar': 'AR',
    'brazil': 'BR', 'br': 'BR',
    'australia': 'AU', 'au': 'AU',
    'new zealand': 'NZ', 'nz': 'NZ',
    'fiji': 'FJ', 'fj': 'FJ',
    'south africa': 'ZA', 'za': 'ZA',
    'kenya': 'KE', 'ke': 'KE',
    'morocco': 'MA', 'ma': 'MA',
  };

  const normalized = (destinationName || destinationCode).trim().toLowerCase();
  const countryCode = countryMap[normalized] || countryMap[destinationCode.toLowerCase()];
  if (countryCode) {
    const codes = Object.entries(CITY_MAP)
      .filter(([, info]) => info.countryCode === countryCode)
      .map(([code]) => code);
    if (codes.length > 0) return codes;
  }

  // Last resort: try the code as-is (might be a valid IATA code not in CITY_MAP)
  return [destinationCode];
}

async function getRelevantDeals(entities: ExtractedEntities) {
  const originCode = entities.originCode;
  const rawDestCode = entities.destinationCode;
  const startDate = entities.startDate;
  const endDate = entities.endDate || entities.startDate;
  const cabin = entities.cabin;

  if (!rawDestCode) return [];

  // Resolve country names/codes to all matching airport codes.
  // e.g. "Japan" -> ["HND", "NRT", "KIX"]
  const destCodes = resolveDestinationCodes(rawDestCode, entities.destination);

  const conditions = [
    inArray(flights.destinationCode, destCodes),
    inArray(deals.category, ['GOOD_DEAL', 'MAYBE_GOOD_DEAL', 'OKAY_DEAL']),
  ];

  if (originCode) conditions.push(eq(flights.originCode, originCode));

  // Broaden date filtering: if the user said "December" without a specific date,
  // search the entire month across any year. Only use exact date range if
  // a specific startDate was provided.
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();

    // If the trip is within a single month and the start date is the 1st,
    // the user probably said "December" — search the whole month.
    if (sameMonth && start.getDate() === 1) {
      const monthNum = start.getMonth() + 1; // JS months are 0-indexed
      conditions.push(sql`EXTRACT(MONTH FROM ${flights.departureDate}) = ${monthNum}`);
    } else {
      // Specific date range — but broaden to +/- 7 days to catch nearby deals
      const broadStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
      const broadEnd = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000);
      conditions.push(gte(flights.departureDate, broadStart));
      conditions.push(lte(flights.departureDate, broadEnd));
    }
  }

  if (cabin) conditions.push(eq(flights.cabin, cabin));

  const rows = await db
    .select({
      id: flights.id,
      originCode: flights.originCode,
      destinationCode: flights.destinationCode,
      departureDate: flights.departureDate,
      returnDate: flights.returnDate,
      cabin: flights.cabin,
      tripType: flights.tripType,
      pointsRequired: flights.pointsRequired,
      taxesAndFees: flights.taxesAndFees,
      bookingUrl: flights.bookingUrl,
      airline: flights.airline,
      duration: flights.duration,
      stops: flights.stops,
      layoverAirport: flights.layoverAirport,
      layoverDuration: flights.layoverDuration,
      aircraftType: flights.aircraftType,
      category: deals.category,
      reasoning: deals.reasoning,
    })
    .from(flights)
    .innerJoin(deals, eq(deals.flightId, flights.id))
    .where(and(...conditions))
    .orderBy(deals.category, flights.pointsRequired)
    .limit(50);

  if (rows.length > 0) {
    if (originCode) {
      // User specified origin — just return top 5 cheapest
      return rows.slice(0, 5);
    }
    // No origin specified — diversify by origin city: pick cheapest from each
    const byOrigin = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byOrigin.get(r.originCode) || [];
      arr.push(r);
      byOrigin.set(r.originCode, arr);
    }
    const diversified: typeof rows = [];
    const pools = Array.from(byOrigin.values());
    let idx = 0;
    while (diversified.length < 5 && pools.some((p) => p.length > 0)) {
      const pool = pools[idx % pools.length];
      if (pool.length > 0) diversified.push(pool.shift()!);
      idx++;
    }

    // If the user didn't specify an origin, try to surface deals from more than
    // one gateway. Cached data may be sparse, so fall back to a live search when
    // we only found a single origin.
    const cachedOrigins = new Set(diversified.map((d) => d.originCode));
    if (!originCode && cachedOrigins.size < 2) {
      const live = await searchSeatsAeroLive({
        originCode,
        destinationCode: destCodes[0],
        startDate,
        cabin,
      });
      if (live.length > 0) return live;
    }

    return diversified;
  }

  // Fallback to live Seats.aero search if no cached deals match.
  return searchSeatsAeroLive({
    originCode,
    destinationCode: destCodes[0], // Use first resolved code for live search
    startDate,
    cabin,
  });
}

async function generateItinerary(state: typeof ConversationStateAnnotation.State) {
  const destination = state.entities.destination || '';
  const startDate = state.entities.startDate;
  const endDate = state.entities.endDate;
  const cabin = state.entities.cabin || 'ECONOMY';
  const travelers = state.entities.travelers || 1;
  const weather = state.weather || 'Not available';
  const news = state.news || 'No recent news found.';
  const feedback = state.criticFeedback.join('\n') || 'None';

  // For refine requests, extract the previous itinerary from chat history
  // so the LLM can modify it instead of generating from scratch.
  const isRefine = state.entities.intent === 'refine';
  let previousItinerary = '';
  if (isRefine && state.history.length > 0) {
    // Find the most recent assistant message with substantial content (the itinerary).
    for (let i = state.history.length - 1; i >= 0; i--) {
      const msg = state.history[i];
      if (msg.role === 'assistant' && msg.content && msg.content.length > 200) {
        previousItinerary = msg.content;
        break;
      }
    }
  }

  let numDays = DEFAULT_TRIP_DAYS;
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    numDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1);
  } else if (state.entities.durationDays && state.entities.durationDays > 0) {
    numDays = state.entities.durationDays;
  }

  // Final safety cap: never generate more than MAX_TRIP_DAYS days
  if (numDays > MAX_TRIP_DAYS) numDays = MAX_TRIP_DAYS;

  const dateContext = startDate
    ? `Trip dates: ${startDate}${endDate ? ` to ${endDate}` : ''} (${numDays} days)`
    : `Trip window: ${state.entities.datesGeneral || 'upcoming'} (${numDays} days)`;

  const requestedStyle = state.entities.budget
    ? 'budget-conscious'
    : cabin === 'BUSINESS' || cabin === 'FIRST'
      ? 'luxury'
      : 'comfortable';
  const prompt = `${COMPANION_PERSONA}

You are helping plan a trip. Write an enthusiastic, practical, ${requestedStyle} itinerary for ${travelers} traveler(s) going to ${destination}.
${dateContext}
Flight cabin: ${cabin}

${state.entities.interests ? `The user is specifically interested in: ${state.entities.interests}. Tailor the itinerary around these interests — prioritize relevant attractions, activities, and venues. Still include a few iconic must-sees, but make the interest-themed activities the centerpiece.` : ''}

${state.userMessage ? `User's original request: "${state.userMessage}"` : ''}

${isRefine && previousItinerary ? `
⚠️ This is a REFINEMENT request. The user wants to modify their existing itinerary. Here is their current itinerary:

---
${previousItinerary}
---

The user's refinement request: "${state.userMessage}"

Modify the existing itinerary based on the user's request. Keep the overall structure and days that the user didn't ask to change. Only modify what the user asked for. If they want fewer days, remove the extra days. If they want more days, add them. If they want to swap an activity, swap it. Preserve the good parts of the existing itinerary.
` : ''}

Weather forecast or climate note:
${typeof weather === 'string' ? weather : JSON.stringify(weather)}

Recent destination news/happenings:
${news}

Critic feedback to address:
${feedback}

${feedback.includes('image placeholder') ? '⚠️ CRITICAL: The previous version was missing image placeholders. You MUST include ![IMAGE: landmark name] after EVERY day heading. This is non-negotiable.' : ''}

${state.userPreferences ? `The user has the following global travel preferences. Strictly adhere to these when recommending food, transport, and flights:\n${JSON.stringify(state.userPreferences, null, 2)}\n` : ''}

Requirements:
- Start with a brief, friendly intro sentence (1-2 lines) before the itinerary.
- Plan EXACTLY ${numDays} days. Do not add or skip days.${numDays >= MAX_TRIP_DAYS ? ' (Note: the trip was capped at 30 days — mention this naturally in the intro if the user asked for longer.)' : ''}
- Never schedule travel, reservations, performances, games, festivals, or other events on a date before today (${new Date().toISOString().split('T')[0]}). Exclude stale past events from retrieved context.
- MANDATORY: For EACH day, you MUST include exactly one image placeholder immediately after the day heading, in this exact format: ![IMAGE: specific landmark name]. No URLs. This is required for every single day — do not skip any day. Pick iconic, specific places (e.g. "Notre-Dame Cathedral", "Sagrada Familia", "Senso-ji Temple"), not generic city names. Always use the ENGLISH name of the landmark (e.g. "Helsinki Cathedral" not "Helsingin Tuomiokirkko", "Church of the Rock" not "Temppeliaukio Kirkko").
- MANDATORY: For EACH day, organize the day into three time blocks with clear sub-headings in this exact format:
  **🌅 Morning:** <activities and stops>
  **🌞 Afternoon:** <activities and stops>
  **🌙 Evening:** <activities and stops>
  Every stop/landmark must fall under exactly one of these three time blocks. Strict time-of-day rules:
  - Morning (09:00–12:00): museums, galleries, shrines, temples, gardens, breakfast spots, morning markets, and attractions that open at 9–10 AM. NEVER schedule a night market or rooftop bar in the Morning.
  - Afternoon (13:00–17:00): museums, galleries, palaces, parks, lunch restaurants, and attractions with standard 09:00–17:00 operating hours. NEVER schedule a night market or nightlife venue in the Afternoon.
  - Evening (18:00–22:00): night markets, rooftop bars, sunset observatories, illuminated landmarks, dinner restaurants, nightlife, and evening walks. NEVER schedule a standard museum, gallery, shrine, or garden in the Evening — these venues are typically closed after 17:00.
  If a venue is open only at night (night market, rooftop bar, observatory), it MUST go in the Evening block. If a venue closes at 17:00 (museum, gallery, shrine), it MUST go in the Morning or Afternoon block.
- Bold every landmark, neighborhood, or major stop you mention in the day plan (e.g. **Louvre Museum**, **Montmartre**, **Eiffel Tower**). This is used to generate walking/transit maps.
- Do not claim upgrades, partner airlines, or premium in-flight services unless cabin is BUSINESS/FIRST.
- Do not invent traveler names.
- Keep the tone warm, like a friend sharing recommendations.
- CRITICAL: Only include real, well-known attractions, restaurants, and transit options. Do not invent names, places, closed venues, transit lines, schedules, or booking details. If you are unsure about a specific place, replace it with a clearly real alternative. For sports venues, use real stadium names (e.g. "Emirates Stadium", "Stamford Bridge", "Wembley Stadium", "Old Trafford", "Anfield", "Etihad Stadium", "Camp Nou", "Santiago Bernabéu", "Metropolitano Stadium", "Allianz Arena", "Signal Iduna Park", "San Siro", "Juventus Stadium", "Parc des Princes", "Stade Vélodrome", "Amsterdam Arena", "Maracanã Stadium", "Monumental Stadium", "Yankee Stadium", "Madison Square Garden", "Fenway Park", "Wrigley Field", "Tokyo Dome", "Sapporo Dome").
- When mentioning transit, use SPECIFIC station/stop names, not generic system names. For example: "Tsim Sha Tsui MTR Station" not "MTR"; "Shinjuku Station" not "JR Line"; "Châtelet Metro Station" not "Metro". This is needed for route planning.

Getting around / transport:
- Include a short "Getting Around" section near the top with general city transit tips (e.g. local metro, day pass, walking, local trains, ride-share).
- Do NOT write per-day transport notes — a dedicated transport agent will inject real walking/driving times and mode recommendations after the itinerary is generated.

Output the response as markdown.
`;

  const res = await qualityLlm!.invoke(prompt);
  return res.content as string;
}

async function generatePackingTips(state: typeof ConversationStateAnnotation.State) {
  const destination = state.entities.destination || '';
  const weather = state.weather;
  const startDate = state.entities.startDate;
  const endDate = state.entities.endDate;
  const interests = state.entities.interests;
  const prompt = `${COMPANION_PERSONA}

Write a concise, friendly packing list for a trip to ${destination} from ${startDate || ''} to ${
    endDate || startDate || ''
  }.
Weather/context: ${typeof weather === 'string' ? weather : JSON.stringify(weather) || 'unknown'}.
${interests ? `The traveler is interested in: ${interests}. Include interest-specific items if relevant (e.g. comfortable walking shoes for stadium tours, team scarf/jersey for football, swimwear for beach trips, camera for photography trips).` : ''}
Output only a markdown bullet list.
`;
  const res = await llm!.invoke(prompt);
  return res.content as string;
}

async function answerNode(state: typeof ConversationStateAnnotation.State) {
  if (!llm) throw new Error('AI provider not configured');

  const destination = state.entities.destination || '';
  const destinationCode = state.entities.destinationCode || destination;
  if (!destination) {
    return { finalResponse: 'I’d love to help, but where are you thinking of going? Just tell me a city or country and I’ll dig up the latest deals and tips.' };
  }

  let startDate = state.entities.startDate ? new Date(state.entities.startDate) : undefined;
  let endDate = state.entities.endDate ? new Date(state.entities.endDate) : undefined;
  if (!startDate) {
    startDate = new Date();
    endDate = new Date(startDate.getTime() + 90 * 24 * 60 * 60 * 1000);
  }

  const [dealsResult, weatherResult, newsResult] = await Promise.all([
    getRelevantDeals({ ...state.entities, startDate: startDate.toISOString().split('T')[0], endDate: endDate?.toISOString().split('T')[0] }),
    getWeatherData(destinationCode, startDate, endDate, destination).catch(() => null),
    searchDestinationNews(destinationCode, startDate, endDate || startDate, destination, state.entities.interests || undefined).catch(() => null),
  ]);

  const dealsText = dealsResult.length
    ? dealsResult
        .map((d) => {
          const bookingUrl = getAirlineBookingUrl(
            d.airline || '',
            d.originCode || '',
            d.destinationCode || '',
            d.departureDate
          );
          const durationText = d.duration ? `${Math.floor(d.duration / 60)}h ${d.duration % 60}m` : '';
          const stopsText = d.stops === 0 ? 'Nonstop' : d.stops === 1 ? '1 stop' : d.stops ? `${d.stops} stops` : '';
          const meta = [durationText, stopsText].filter(Boolean).join(' · ');
          return `- ${d.originCode || 'Any'} → ${d.destinationCode} · ${d.airline} · ${d.cabin} · ${d.pointsRequired?.toLocaleString() || '?'} pts + $${d.taxesAndFees || '0'} taxes${meta ? ` · ${meta}` : ''} · [book on airline site](${bookingUrl})`;
        })
        .join('\n')
    : 'No matching points deals found right now.';

  const prompt = `${COMPANION_PERSONA}

The user asked: "${state.userMessage}"

Destination: ${destination}
Trip window: ${startDate.toISOString().split('T')[0]} to ${endDate?.toISOString().split('T')[0]}

Weather outlook:
${typeof weatherResult === 'string' ? weatherResult : JSON.stringify(weatherResult) || 'Not available'}

Recent news/happenings:
${newsResult || 'No recent news found.'}

Points flight deals in this window:
${dealsText}

Give a friendly, conversational answer to the user's question. If there are good deals, highlight the best ones. If not, suggest a better time window or next step. Keep it to 3-5 short paragraphs and invite follow-up questions.

Output the response as markdown without a heading.`;

  const res = await llm.invoke(prompt);
  return { finalResponse: res.content as string, deals: dealsResult, weather: weatherResult, news: newsResult };
}

async function guardrailsNode(state: typeof ConversationStateAnnotation.State) {
  if (!state.itinerary) return { criticFeedback: [] };
  const feedback: string[] = [];

  // Check 1: Verify landmarks exist on Wikipedia.
  const unverified = await verifyItineraryLandmarks(state.itinerary, state.entities.destination);
  if (unverified.length > 0) {
    console.warn('[Guardrails] Unverified itinerary image landmarks:', unverified);
    feedback.push(`The following places or landmarks could not be verified and may be hallucinated or closed: ${unverified.join(', ')}. Replace them with real, well-known attractions or transit options that are clearly documented.`);
  }

  // Check 2: Verify image placeholders are present for each day.
  const dayCount = (state.itinerary.match(/#{1,4}\s+Day\s+\d+/gi) || []).length;
  const placeholderCount = (state.itinerary.match(/!\[IMAGE:/gi) || []).length;
  const expectedDays = getExpectedTripDays(state.entities.startDate, state.entities.endDate, state.entities.durationDays);
  if (expectedDays && dayCount !== expectedDays) {
    feedback.push(`The user requested ${expectedDays} travel days, but the itinerary contains ${dayCount} day headings. Regenerate it with exactly ${expectedDays} days.`);
  }
  if (dayCount > 0 && placeholderCount < dayCount) {
    feedback.push(`The itinerary has ${dayCount} day(s) but only ${placeholderCount} image placeholder(s). Every day MUST have exactly one image placeholder in the format ![IMAGE: landmark name] immediately after the day heading. Add the missing placeholders.`);
  }

  const pastDates = findPastCalendarDates(state.itinerary);
  if (pastDates.length > 0) {
    feedback.push(`The itinerary contains past calendar dates: ${pastDates.join(', ')}. Remove past events and regenerate the plan using only current or future travel dates and events.`);
  }

  // Check 3: Verify each day has Morning/Afternoon/Evening time blocks.
  // Only flag if the day has NONE of the three time slots — individual missing
  // slots are a formatting preference, not a safety issue.
  const dayBlocks = state.itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
  const daysMissingAllTimeBlocks: string[] = [];
  for (const block of dayBlocks) {
    const headingMatch = block.match(/#+\s+Day\s+(\d+)/i);
    if (!headingMatch) continue;
    const dayNum = headingMatch[1];
    const hasMorning = /morning/i.test(block);
    const hasAfternoon = /afternoon/i.test(block);
    const hasEvening = /evening/i.test(block);
    if (!hasMorning && !hasAfternoon && !hasEvening) {
      daysMissingAllTimeBlocks.push(`Day ${dayNum}`);
    }
  }
  if (daysMissingAllTimeBlocks.length > 0) {
    feedback.push(`The following days have no time blocks at all: ${daysMissingAllTimeBlocks.join(', ')}. Reformat each day with three sub-sections using **🌅 Morning:**, **🌞 Afternoon:**, and **🌙 Evening:** headings.`);
  }

  return { criticFeedback: feedback };
}

async function criticNode(state: typeof ConversationStateAnnotation.State) {
  const { userQuery, retrievedContext, draftItinerary } = state;
  const guardrailsFeedback = state.criticFeedback;

  try {
    const evaluation = await evaluateRag(userQuery, retrievedContext, draftItinerary);
    if (!evaluation) {
      return {
        isApproved: false,
        criticFeedback: ['RAG evaluation could not be completed. Regenerate the itinerary before responding.'],
        ragEvaluation: null,
        revisionCount: state.revisionCount + 1,
      };
    }

    const evaluationFeedback = [
      evaluation.groundedness.score < 4
        ? `Groundedness (${evaluation.groundedness.score}/5): ${evaluation.groundedness.reasoning}`
        : '',
      evaluation.answerRelevance.score < 4
        ? `Answer relevance (${evaluation.answerRelevance.score}/5): ${evaluation.answerRelevance.reasoning}`
        : '',
    ].filter((feedback): feedback is string => feedback.length > 0);
    const feedback = [...guardrailsFeedback, ...evaluationFeedback];
    // Refinements are user-driven edits. They don't have fresh retrieved context,
    // so once guardrails are clean we should let the user's change through.
    const isApproved =
      guardrailsFeedback.length === 0 &&
      (state.entities.intent === 'refine' ||
        (evaluation.groundedness.score >= 4 && evaluation.answerRelevance.score >= 4));

    return {
      isApproved,
      criticFeedback: isApproved ? [] : feedback,
      ragEvaluation: evaluation,
      revisionCount: state.revisionCount + 1,
    };
  } catch (error: unknown) {
    console.error('[RAG Evaluator] Critic evaluation failed:', error);
    // If guardrails are clean, treat a failing RAG evaluation as a soft pass
    // so a user-facing response can still be returned.
    const guardrailsClean = guardrailsFeedback.length === 0;
    return {
      isApproved: guardrailsClean,
      criticFeedback: guardrailsClean
        ? []
        : ['RAG evaluation failed. Regenerate the itinerary before responding.'],
      ragEvaluation: null,
      revisionCount: state.revisionCount + 1,
    };
  }
}

function criticRouter(state: typeof ConversationStateAnnotation.State) {
  if (state.isApproved) return 'enrich';
  if (state.revisionCount >= 3) return 'reject';
  // First refine attempt uses the surgical patch. If that fails, fall back to
  // a full regeneration so the user's constraint is still honored.
  if (state.entities.intent === 'refine') return 'generate';
  return 'generate';
}

function rejectNode() {
  return {
    finalResponse: 'I could not verify this itinerary strongly enough to share it safely. Please try again so I can regenerate it with better-supported travel details.',
  };
}

async function respondNode(state: typeof ConversationStateAnnotation.State) {
  if (state.entities.intent === 'greeting') {
    return {
      finalResponse: `Hi! I'm Jalan, your travel planning buddy. Tell me where you want to go and when — for example, "I want to plan a trip to Tokyo in October" — and I'll build a day-by-day itinerary, check the weather, find points flight deals, and suggest what to pack.`,
    };
  }

  const destination = state.entities.destination || '';
  const startDate = state.entities.startDate;
  const endDate = state.entities.endDate;
  const dateStr = startDate
    ? `${startDate}${endDate ? ` - ${endDate}` : ''}`
    : state.entities.datesGeneral || 'upcoming dates';

  // Images are already hydrated in enrichNode (runs concurrently with transport).
  // Deals are rendered as rich cards in the payload, not in the markdown.
  const packingSection = state.packingTips
    ? `\n---\n\n## 🧳 Packing Tips\n\n${state.packingTips}`
    : '';
  const finalResponse = `# ${destination} Itinerary — ${dateStr}

${state.itinerary}
${packingSection}

${state.criticFeedback.length > 0 && !state.isApproved ? '\n_Note: Some details were adjusted after review._' : ''}
`;

  return { finalResponse };
}

export function heuristicTitle(message: string): string {
  const clean = message.trim().replace(/\s+/g, ' ');
  if (clean.length <= 40) return clean;
  return clean.slice(0, 37) + '...';
}

export async function generateTitle(message: string) {
  if (!llm) return heuristicTitle(message);
  const prompt = `${COMPANION_PERSONA}

Create a short, specific title (2-5 words) for a trip planning conversation that starts with this message. Use the destination and date if mentioned. Do NOT use generic titles like "New trip" or "Trip planning". Output only the title, no quotes, no extra punctuation.

Examples:
- Message: "I want to go to Tokyo in October" -> Title: Tokyo in October
- Message: "honeymoon in Thailand for 2 weeks" -> Title: Thailand Honeymoon
- Message: "budget trip to Seoul next month" -> Title: Budget Seoul Trip

Message: ${message}
Title:`;
  try {
    const res = await llm.invoke(prompt);
    let title = (res.content as string).trim().replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
    if (!title || title.toLowerCase().includes('new trip') || title.toLowerCase().includes('trip planning')) {
      return heuristicTitle(message);
    }
    return title.length > 60 ? title.slice(0, 57) + '...' : title;
  } catch {
    return heuristicTitle(message);
  }
}

export const conversationGraph = new StateGraph(ConversationStateAnnotation)
  .addNode('extract', extractNode)
  .addNode('clarify', clarifyNode)
  .addNode('clarifyLimit', clarifyLimitNode)
  .addNode('answer', answerNode)
  .addNode('gather', gatherNode)
  .addNode('generate', generateNode)
  .addNode('applyRefinements', applyRefinements)
  .addNode('guardrails', guardrailsNode)
  .addNode('enrich', enrichNode)
  .addNode('critic', criticNode)
  .addNode('respond', respondNode)
  .addNode('reject', rejectNode)
  .addEdge(START, 'extract')
  .addConditionalEdges('extract', routeAfterExtract)
  .addEdge('clarify', END)
  .addEdge('clarifyLimit', END)
  .addEdge('answer', END)
  .addEdge('gather', 'generate')
  .addEdge('generate', 'guardrails')
  .addEdge('applyRefinements', 'guardrails')
  .addEdge('guardrails', 'critic')
  .addConditionalEdges('critic', criticRouter)
  .addEdge('enrich', 'respond')
  .addEdge('respond', END)
  .addEdge('reject', END)
  // Checkpointed per conversation (thread_id) so a run can pause at END and
  // resume with the same state on the next request.
  .compile({ checkpointer: getCheckpointer() ?? undefined });
