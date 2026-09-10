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
}

export interface ClarifyingQuestion {
  question: string;
  examples: string[];
}

import type { TransportPlan } from '../agents/transport';

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
  missingFields: string[];
  questions: ClarifyingQuestion[];
  weather: any | null;
  news: string | null;
  deals: any[];
  images: Record<string, string>;
  itinerary: string;
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
  todos: { id: string; text: string; done: boolean }[];
  notes: string;
  // Per-stop feedback keyed by landmark name (lowercased).
  feedback: Record<string, StopFeedback>;
  // Manual flight/hotel/train/etc entries.
  flightInfo: ManualFlightEntry[];
  // Uploaded PDF e-tickets, vouchers, etc.
  documents: UploadedDocument[];
  savedAt: string;
}
