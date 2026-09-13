import { pgTable, uuid, varchar, integer, decimal, timestamp, boolean, pgEnum, text, jsonb, index, doublePrecision } from 'drizzle-orm/pg-core';

export const dealCategoryEnum = pgEnum('deal_category', ['GOOD_DEAL', 'MAYBE_GOOD_DEAL', 'OKAY_DEAL', 'BAD_DEAL']);
export const fareTypeEnum = pgEnum('fare_type', ['CASH', 'POINTS']);
export const cabinClassEnum = pgEnum('cabin_class', ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']);
export const regionEnum = pgEnum('origin_region', ['WEST_COAST', 'CENTRAL', 'EAST_COAST']);
export const occasionEnum = pgEnum('occasion', ['HONEYMOON', 'BUSINESS', 'LEISURE', 'FAMILY', 'FRIENDS', 'SOLO', 'OTHER']);
export const tripTypeEnum = pgEnum('trip_type', ['ONE_WAY', 'ROUND_TRIP']);

export const flights = pgTable('flights', {
  id: uuid('id').primaryKey().defaultRandom(),
  originCode: varchar('origin_code', { length: 5 }).notNull(),
  originRegion: regionEnum('origin_region').notNull(),
  destinationCode: varchar('destination_code', { length: 5 }).notNull(),
  airline: varchar('airline', { length: 100 }).notNull(),
  departureDate: timestamp('departure_date').notNull(),
  returnDate: timestamp('return_date'),
  cabin: cabinClassEnum('cabin').notNull().default('ECONOMY'),
  fareType: fareTypeEnum('fare_type').notNull().default('CASH'),
  tripType: tripTypeEnum('trip_type').notNull().default('ROUND_TRIP'),
  cashPrice: decimal('cash_price', { precision: 10, scale: 2 }),
  pointsRequired: integer('points_required'),
  taxesAndFees: decimal('taxes_and_fees', { precision: 10, scale: 2 }),
  bookingUrl: varchar('booking_url', { length: 1000 }),
  isSimulated: boolean('is_simulated').default(false).notNull(),
  scrapedAt: timestamp('scraped_at').defaultNow().notNull(),
  // Representative cash-flight details for the modal (not the exact award itinerary)
  cashAirline: varchar('cash_airline', { length: 100 }),
  duration: integer('duration'),
  stops: integer('stops'),
  layoverAirport: varchar('layover_airport', { length: 5 }),
  layoverDuration: integer('layover_duration'),
  aircraftType: varchar('aircraft_type', { length: 100 }),
  segments: text('segments'), // JSON string of representative flight segments
});

export const deals = pgTable('deals', {
  id: uuid('id').primaryKey().defaultRandom(),
  flightId: uuid('flight_id').references(() => flights.id, { onDelete: 'cascade' }).notNull(),
  category: dealCategoryEnum('category').notNull(),
  reasoning: varchar('reasoning', { length: 1000 }).notNull(),
  itinerary: text('itinerary'), // Stores the LangGraph output
  occasion: occasionEnum('occasion').notNull().default('LEISURE'),
  isNotified: boolean('is_notified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 255 }),
  sessionId: uuid('session_id'),
  title: varchar('title', { length: 255 }),
  metadata: text('metadata'), // JSON: { destination, dates, origin, cabin, ... }
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('conversations_user_id_idx').on(table.userId),
  sessionIdx: index('conversations_session_id_idx').on(table.sessionId),
  updatedAtIdx: index('conversations_updated_at_idx').on(table.updatedAt),
}));

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  payload: text('payload'), // JSON: itinerary, weather, deals, tool calls, critic feedback
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  conversationIdx: index('messages_conversation_id_idx').on(table.conversationId),
  createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
}));

// Shared trips — a snapshot of a conversation's latest itinerary that can
// be viewed by anyone with the share ID. Used for the "Share trip link" feature.
export const sharedTrips = pgTable('shared_trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: varchar('user_id', { length: 255 }),
  title: varchar('title', { length: 255 }),
  destination: varchar('destination', { length: 255 }),
  itinerary: text('itinerary').notNull(),
  payload: text('payload'), // JSON: full ChatPayload (weather, deals, images, etc.)
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  conversationIdx: index('shared_trips_conversation_id_idx').on(table.conversationId),
}));

// Saved trips — a user's saved trip to their One Stop panel.
// Keyed by Clerk userId so trips sync across devices.
// Guests use localStorage as a fallback (no DB row).
export const savedTrips = pgTable('saved_trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  conversationId: varchar('conversation_id', { length: 255 }),
  destination: varchar('destination', { length: 255 }).notNull(),
  dates: varchar('dates', { length: 255 }),
  payload: text('payload').notNull(), // JSON: full ChatPayload
  weatherAlert: text('weather_alert'),
  weatherSnapshot: text('weather_snapshot'), // JSON: live forecast for the destination
  weatherUpdatedAt: timestamp('weather_updated_at'),
  todos: text('todos').notNull().default('[]'), // JSON: [{ id, text, done }]
  notes: text('notes').notNull().default(''),
  feedback: text('feedback').notNull().default('{}'), // JSON: Record<stopName, StopFeedback>
  dayFeedback: text('day_feedback').notNull().default('{}'), // JSON: Record<dayIndex, DayFeedback>
  flightInfo: text('flight_info').notNull().default('[]'), // JSON: ManualFlightEntry[]
  documents: text('documents').notNull().default('[]'), // JSON: UploadedDocument[]
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('saved_trips_user_id_idx').on(table.userId),
}));

// Deal alerts — a user's saved search criteria for price drop notifications.
// When the scraper finds a new GOOD_DEAL matching these criteria, the user
// gets an email notification. Keyed by Clerk userId.
export const dealAlerts = pgTable('deal_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  origin: varchar('origin', { length: 10 }), // IATA code, or null for "any origin"
  destination: varchar('destination', { length: 10 }), // IATA code, or null for "any destination"
  cabin: varchar('cabin', { length: 20 }), // ECONOMY, BUSINESS, FIRST, PREMIUM_ECONOMY, or null for "any cabin"
  month: varchar('month', { length: 7 }), // YYYY-MM, or null for "any month"
  minCPP: decimal('min_cpp', { precision: 5, scale: 2 }).notNull().default('1.5'), // minimum cents-per-point to trigger
  lastNotifiedAt: timestamp('last_notified_at'), // last time this alert sent an email
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('deal_alerts_user_id_idx').on(table.userId),
  activeIdx: index('deal_alerts_is_active_idx').on(table.isActive),
}));

// Geocoding cache for Nominatim/OpenStreetMap lookups.
// Keyed by a normalized "landmark:city" string to avoid redundant API calls.
export const geocodedLocations = pgTable('geocoded_locations', {
  queryKey: text('query_key').primaryKey(),
  lat: doublePrecision('lat').notNull(),
  lon: doublePrecision('lon').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Global travel preferences for authenticated users, injected into the
// LangGraph system prompt to personalize itineraries.
export const userPreferences = pgTable('user_preferences', {
  userId: varchar('user_id', { length: 255 }).primaryKey(),
  dietaryRestrictions: text('dietary_restrictions'),
  transportPreference: text('transport_preference'),
  airlinePreference: text('airline_preference'),
  generalNotes: text('general_notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('user_preferences_user_id_idx').on(table.userId),
}));

// Multiplayer AI collaboration: who can view or edit a saved trip.
export const collaboratorRoleEnum = pgEnum('collaborator_role', ['owner', 'collaborator']);

export const tripCollaborators = pgTable('trip_collaborators', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').references(() => savedTrips.id, { onDelete: 'cascade' }).notNull(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  role: collaboratorRoleEnum('role').notNull().default('collaborator'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tripUserIdx: index('trip_collaborators_trip_user_idx').on(table.tripId, table.userId),
  tripIdx: index('trip_collaborators_trip_id_idx').on(table.tripId),
}));

// Invite links that add a signed-in user to a saved trip as a Disciple
// (owner-level) or a Follower (collaborator).
export const tripInvites = pgTable('trip_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').references(() => savedTrips.id, { onDelete: 'cascade' }).notNull(),
  token: varchar('token', { length: 64 }).notNull().unique(),
  role: collaboratorRoleEnum('role').notNull().default('collaborator'),
  createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index('trip_invites_token_idx').on(table.token),
  tripIdx: index('trip_invites_trip_id_idx').on(table.tripId),
}));

// Proposed AI-generated itinerary patches awaiting owner approval.
export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'accepted', 'rejected']);

export const tripProposals = pgTable('trip_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').references(() => savedTrips.id, { onDelete: 'cascade' }).notNull(),
  proposedByUserId: varchar('proposed_by_user_id', { length: 255 }).notNull(),
  status: proposalStatusEnum('status').notNull().default('pending'),
  suggestedPrompt: text('suggested_prompt').notNull(),
  patchData: jsonb('patch_data').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tripIdx: index('trip_proposals_trip_id_idx').on(table.tripId),
  statusIdx: index('trip_proposals_status_idx').on(table.status),
}));
