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

export interface SavedTrip {
  id: string;
  conversationId: string;
  destination: string;
  dates: string;
  payload: ChatPayload;
  todos: { id: string; text: string; done: boolean }[];
  notes: string;
  savedAt: string;
}
