/**
 * RAG Evaluator — LLM-as-a-judge evaluation pipeline.
 *
 * Grades the generated itinerary against the RAG Triad:
 *   1. Context Relevance  — Was the retrieved travel context useful for the user's intent?
 *   2. Groundedness        — Is every claim in the itinerary backed by the retrieved context (no hallucinations)?
 *   3. Answer Relevance    — Does the itinerary actually answer what the user asked for?
 *
 * Each metric produces a numeric score (1-5) and a string reasoning.
 *
 * Provider strategy:
 *   - OpenAI: uses the raw `openai` SDK with `zodResponseFormat` for strict schema enforcement.
 *   - Gemini: uses LangChain's `withStructuredOutput(zodSchema)` which binds the zod schema
 *     to the model's function-calling / structured-output layer.
 */

import { z } from 'zod';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getQualityModel, hasOpenAI, hasGemini } from './ai-provider';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// NOTE: Each metric is defined inline (not via a shared z.object) to avoid
// generating $ref references in the JSON schema, which Gemini's function
// declaration API does not support. OpenAI handles $ref fine, but we need
// cross-provider compatibility.

export const RagEvaluationSchema = z.object({
  contextRelevance: z.object({
    score: z.number().int().min(1).max(5).describe('Integer score from 1 (worst) to 5 (best)'),
    reasoning: z.string().min(1).describe('2-4 sentence explanation justifying the score, citing specific examples'),
  }).describe(
    'Was the retrieved travel context (weather, news, deals, images) relevant and useful for fulfilling the user intent?',
  ),
  groundedness: z.object({
    score: z.number().int().min(1).max(5).describe('Integer score from 1 (worst) to 5 (best)'),
    reasoning: z.string().min(1).describe('2-4 sentence explanation justifying the score, citing specific examples'),
  }).describe(
    'Is every factual claim, landmark, restaurant, transit detail, and flight in the itinerary supported by the retrieved context? Flag any hallucinated or unsupported details.',
  ),
  answerRelevance: z.object({
    score: z.number().int().min(1).max(5).describe('Integer score from 1 (worst) to 5 (best)'),
    reasoning: z.string().min(1).describe('2-4 sentence explanation justifying the score, citing specific examples'),
  }).describe(
    'Does the itinerary directly address the user original request — correct destination, dates, interests, cabin class, and traveler count?',
  ),
  overallScore: z
    .number()
    .min(1)
    .max(5)
    .describe('Average of the three metric scores (can be a decimal)'),
  summary: z
    .string()
    .describe('One-paragraph executive summary of the evaluation, highlighting the biggest risk if any'),
});

export type RagEvaluation = z.infer<typeof RagEvaluationSchema>;

// ---------------------------------------------------------------------------
// Types for inputs
// ---------------------------------------------------------------------------

export interface RagEvaluationInput {
  /** The user's original message + extracted intent (from Extract / Clarify nodes) */
  userIntent: {
    message: string;
    destination?: string;
    startDate?: string;
    endDate?: string;
    interests?: string;
    cabin?: string;
    travelers?: number;
    intent?: string;
  };
  /** Retrieved context assembled by the Gather node */
  retrievedContext: {
    weather: unknown;
    news: string | null;
    deals: unknown[];
    images: Record<string, string>;
    rawContext?: string;
  };
  /** The final drafted itinerary markdown */
  itinerary: string;
}

// ---------------------------------------------------------------------------
// Evaluation prompt
// ---------------------------------------------------------------------------

function buildEvaluationPrompt(input: RagEvaluationInput): string {
  const { userIntent, retrievedContext, itinerary } = input;

  const intentBlock = [
    `Original user message: "${userIntent.message}"`,
    userIntent.destination && `Destination: ${userIntent.destination}`,
    userIntent.startDate && `Start date: ${userIntent.startDate}`,
    userIntent.endDate && `End date: ${userIntent.endDate}`,
    userIntent.interests && `Interests: ${userIntent.interests}`,
    userIntent.cabin && `Cabin: ${userIntent.cabin}`,
    userIntent.travelers && `Travelers: ${userIntent.travelers}`,
    userIntent.intent && `Detected intent: ${userIntent.intent}`,
  ]
    .filter(Boolean)
    .join('\n');

  const weatherStr =
    typeof retrievedContext.weather === 'string'
      ? retrievedContext.weather
      : JSON.stringify(retrievedContext.weather, null, 2);

  const dealsStr =
    retrievedContext.deals.length > 0
      ? JSON.stringify(retrievedContext.deals.slice(0, 10), null, 2)
      : 'No deals retrieved';

  const imagesStr =
    Object.keys(retrievedContext.images).length > 0
      ? JSON.stringify(retrievedContext.images)
      : 'No images retrieved';

  return `You are an impartial judge evaluating a travel itinerary generated by a RAG (Retrieval-Augmented Generation) system.

You will be given three inputs:
1. USER INTENT — what the user asked for (extracted by the system).
2. RETRIEVED CONTEXT — the data the system gathered from external sources (weather, news, flight deals, images).
3. DRAFTED ITINERARY — the final itinerary presented to the user.

Base every statement on the three inputs above. Quote dates and values exactly as
they appear. Do NOT estimate or compute magnitudes — never write things like "off
by 1.5 years", "three days too long", or "20% cheaper". If a number is not stated
in the inputs, describe the mismatch qualitatively ("the draft is dated in a
different season than requested") and let the score carry the severity.

Grade the itinerary on the RAG Triad using a 1-5 scale for each metric:

### 1. Context Relevance (1-5)
Was the retrieved context actually useful for planning this trip?
- 5: All retrieved data (weather, news, deals) is directly relevant and used.
- 3: Some context is relevant but parts are missing or tangential.
- 1: Retrieved context is irrelevant, stale, or missing entirely.

### 2. Groundedness / Faithfulness (1-5)
Is every factual claim in the itinerary backed by the retrieved context?
- 5: Every landmark, restaurant, transit detail, and flight is supported by context or well-known fact.
- 3: Most claims are grounded but a few specifics (e.g. transit schedules, restaurant names) appear unverified.
- 1: Multiple hallucinated locations, fake restaurants, invented transit lines, or fabricated flight deals.

### 3. Answer Relevance (1-5)
Does the itinerary actually answer what the user asked for?
- 5: Perfectly matches destination, dates, interests, cabin, and traveler count.
- 3: Addresses the main request but misses secondary preferences (e.g. interests not reflected).
- 1: Wrong destination, wrong dates, or completely ignores the user's request.

Also provide an overallScore (average of the three) and a concise summary.

---

USER INTENT:
${intentBlock}

RETRIEVED CONTEXT:
${retrievedContext.rawContext || `Weather:
${weatherStr}

Recent news:
${retrievedContext.news || 'None retrieved'}

Flight deals:
${dealsStr}

Images:
${imagesStr}`}

DRAFTED ITINERARY:
${itinerary}

---

Evaluate now. Be strict but fair. If you detect hallucinated locations or ignored constraints, explain exactly which ones in the groundedness and answer relevance reasoning.`;
}

// ---------------------------------------------------------------------------
// Evaluation function
// ---------------------------------------------------------------------------

/**
 * Runs the LLM-as-a-judge evaluation on the RAG triad.
 *
 * Uses the OpenAI SDK with `zodResponseFormat` when an OpenAI key is available,
 * falling back to LangChain's `withStructuredOutput` (Gemini) otherwise.
 *
 * Returns a strictly-typed `RagEvaluation` object, or `null` if no AI provider
 * is configured.
 */
export async function evaluateRag(
  userQuery: string,
  retrievedContext: string,
  draftItinerary: string,
  requested?: {
    destination?: string;
    startDate?: string;
    endDate?: string;
    interests?: string;
  },
): Promise<RagEvaluation | null> {
  return evaluateRagQuality({
    userIntent: { message: userQuery, ...requested },
    retrievedContext: {
      weather: null,
      news: null,
      deals: [],
      images: {},
      rawContext: retrievedContext,
    },
    itinerary: draftItinerary,
  });
}

export async function evaluateRagQuality(input: RagEvaluationInput): Promise<RagEvaluation | null> {
  const prompt = buildEvaluationPrompt(input);

  // --- OpenAI path: strict schema enforcement via zodResponseFormat ---
  if (hasOpenAI) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && !openaiKey.includes('your_openai_api_key')) {
      const client = new OpenAI({ apiKey: openaiKey });
      const completion = await client.beta.chat.completions.parse({
        model: process.env.CHAT_MODEL || 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: zodResponseFormat(RagEvaluationSchema, 'rag_evaluation'),
        temperature: 0.2,
      });

      const result = completion.choices[0]?.message?.parsed;
      if (result) {
        logEvaluation(result, input);
        return result;
      }
    }
  }

  // --- Gemini / LangChain path: structured output via withStructuredOutput ---
  if (hasGemini) {
    const model = getQualityModel(0.2);
    if (model) {
      // Cast to any: both ChatGoogleGenerativeAI and ChatOpenAI support
      // withStructuredOutput at runtime, but their TypeScript overloads
      // are incompatible in a union type.
      const structured = (model as any).withStructuredOutput(RagEvaluationSchema);
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = RagEvaluationSchema.parse(await structured.invoke(prompt));
          logEvaluation(result, input);
          return result;
        } catch (error: unknown) {
          lastError = error;
          console.warn(`[RAG Evaluator] Structured-output attempt ${attempt}/2 failed.`);
        }
      }
      throw lastError;
    }
  }

  console.warn('[RAG Evaluator] No AI provider configured — skipping evaluation.');
  return null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logEvaluation(eval_: RagEvaluation, input: RagEvaluationInput) {
  const dest = input.userIntent.destination || 'unknown';
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RAG EVALUATION — Destination: ${dest}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Context Relevance : ${eval_.contextRelevance.score}/5 — ${eval_.contextRelevance.reasoning}`);
  console.log(`  Groundedness      : ${eval_.groundedness.score}/5 — ${eval_.groundedness.reasoning}`);
  console.log(`  Answer Relevance  : ${eval_.answerRelevance.score}/5 — ${eval_.answerRelevance.reasoning}`);
  console.log(`  Overall           : ${eval_.overallScore}/5`);
  console.log(`  Summary           : ${eval_.summary}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Traceability: flag low scores for debugging retrieval or generation
  if (eval_.groundedness.score <= 2) {
    console.warn('  ⚠️  LOW GROUNDEDNESS — possible hallucinated locations. Check Gather node retrieval quality.');
  }
  if (eval_.contextRelevance.score <= 2) {
    console.warn('  ⚠️  LOW CONTEXT RELEVANCE — retrieved data may not match user intent. Check database query filters.');
  }
  if (eval_.answerRelevance.score <= 2) {
    console.warn('  ⚠️  LOW ANSWER RELEVANCE — itinerary ignores user constraints. Check Extract node entity parsing.');
  }
}
