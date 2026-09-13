export interface UserPreferences {
  dietaryRestrictions?: string | null;
  transportPreference?: string | null;
  airlinePreference?: string | null;
  generalNotes?: string | null;
}

export interface ExtractedEntities {
  destination?: string;
  destinationCode?: string;
  origin?: string;
  originCode?: string;
  startDate?: string;
  endDate?: string;
  datesGeneral?: string;
  durationDays?: number;
  cabin?: 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
  travelers?: number;
  budget?: string;
  intent?: 'plan_trip' | 'ask_question' | 'refine' | 'greeting' | 'vague';
  interests?: string;
  refinementInstructions?: string;
}

export interface ClarifyingQuestion {
  question: string;
  examples: string[];
}

import type { TransportPlan } from '../agents/transport';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Itinerary Patch Schema (Delta Update pattern for the refine intent)
// ---------------------------------------------------------------------------
// Instead of regenerating the entire itinerary when a user asks for a small
// change, the LLM outputs a JSON array of specific edits. The deterministic
// mergeItineraryPatch() reducer in src/agents/refine-itinerary.ts applies
// them to the existing itinerary markdown.

export const ItineraryPatchSchema = z.object({
  edits: z.array(
    z.object({
      dayNumber: z.number().int().min(1).describe('The day number to edit (1-indexed)'),
      action: z
        .enum(['replace_stop', 'add_stop', 'remove_stop', 'update_note'])
        .describe('The edit operation to perform'),
      targetStopName: z
        .string()
        .optional()
        .describe('The exact name of the stop to replace/remove/update. Required for replace_stop, remove_stop, and update_note. Omit for add_stop.'),
      newDetails: z
        .object({
          name: z.string().optional().describe('New stop name (for replace_stop or add_stop)'),
          description: z.string().optional().describe('New description text for the stop or note'),
          time_slot: z
            .string()
            .optional()
            .describe('Time slot for add_stop: "morning", "afternoon", or "evening"'),
        })
        .optional()
        .describe('The new details for the stop. Required for replace_stop and add_stop.'),
    })
  ),
});

export type ItineraryPatch = z.infer<typeof ItineraryPatchSchema>;
export type ItineraryEdit = ItineraryPatch['edits'][number];

export interface RouteLink {
  day: string;
  title: string;
  highlights: string;
  url: string;
}

export interface ChatPayload {
  entities?: ExtractedEntities;
  weather?: any;
  news?: string;
  deals?: any[];
  images?: Record<string, string>;
  itinerary?: string;
  routeLinks?: RouteLink[];
  transportPlan?: TransportPlan;
  packingTips?: string;
  feedback?: string[];
}

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  payload?: ChatPayload;
}

export interface ConversationState {
  userMessage: string;
  history: PersistedMessage[];
  entities: ExtractedEntities;
  userPreferences?: UserPreferences | null;
  missingFields: string[];
  questions: ClarifyingQuestion[];
  weather: any | null;
  news: string | null;
  deals: any[];
  images: Record<string, string>;
  itinerary: string;
  currentItinerary: string;
  previousItineraries: string[];
  packingTips: string;
  criticFeedback: string[];
  isApproved: boolean;
  revisionCount: number;
  finalResponse: string;
}

export interface ChatMessageUI {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload?: ChatPayload;
  status?: string;
  isStreaming?: boolean;
}

// Per-stop collaboration feedback for saved trips.
export interface StopComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface StopFeedback {
  stopId: string;
  thumbsUp: number;
  thumbsDown: number;
  userVote?: 'up' | 'down' | null;
  comments: StopComment[];
}

// Per-day collaboration feedback for saved trips.
export interface DayComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface DayFeedback {
  dayIndex: number;
  thumbsUp: number;
  thumbsDown: number;
  userVote?: 'up' | 'down' | null;
  comments: DayComment[];
}

// Live destination forecast shown in the One Stop Weather tab.
export interface WeatherSnapshotDay {
  date: string;              // YYYY-MM-DD
  code: number | null;       // WMO weather code
  condition: string;         // e.g. "Rain"
  maxTemp: number | null;    // °C
  minTemp: number | null;    // °C
  precipitationMm: number | null;
  precipitationProbability: number | null; // 0-100
  windGusts: number | null;  // km/h
}

export interface WeatherSnapshot {
  updatedAt: string;
  timezone: string | null;
  days: WeatherSnapshotDay[];
}

// Manual flight/hotel/document entry for the Flights & Docs tab.
export interface ManualFlightEntry {
  id: string;
  type: 'flight' | 'hotel' | 'train' | 'car' | 'other';
  label: string;          // e.g. "Outbound Flight", "Hotel in Paris"
  airlineOrProvider: string; // e.g. "JAL", "Marriott"
  confirmationCode: string; // PNR / booking ref
  departureTime?: string;    // ISO datetime
  arrivalTime?: string;      // ISO datetime
  notes?: string;
  documentIds?: string[];    // PDFs attached to this booking
  createdAt: string;
}

// Uploaded document (PDF e-ticket, hotel voucher, etc.).
// Stored as a base64 data URL so it round-trips through the JSON payload
// without needing a separate file storage service.
export interface UploadedDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;       // base64 data URL
  uploadedAt: string;
}

export interface SavedTrip {
  id: string;
  conversationId: string;
  destination: string;
  dates: string;
  payload: ChatPayload;
  weatherAlert?: string | null;
  weatherSnapshot?: WeatherSnapshot | null;
  weatherUpdatedAt?: string | null;
  todos: { id: string; text: string; done: boolean }[];
  notes: string;
  // Per-stop feedback keyed by landmark name (lowercased).
  feedback: Record<string, StopFeedback>;
  // Per-day feedback keyed by day index (1-based).
  dayFeedback: Record<string, DayFeedback>;
  // Manual flight/hotel/train/etc entries.
  flightInfo: ManualFlightEntry[];
  // Uploaded PDF e-tickets, vouchers, etc.
  documents: UploadedDocument[];
  savedAt: string;
}
