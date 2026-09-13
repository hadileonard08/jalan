import type { savedTrips } from '../db/schema';

// Single source of truth for the SavedTrip shape sent to the client.
export function serializeSavedTrip(t: typeof savedTrips.$inferSelect) {
  return {
    id: t.id,
    conversationId: t.conversationId || '',
    destination: t.destination,
    dates: t.dates || 'Dates TBD',
    weatherAlert: t.weatherAlert,
    weatherSnapshot: t.weatherSnapshot ? JSON.parse(t.weatherSnapshot) : null,
    weatherUpdatedAt: t.weatherUpdatedAt ? t.weatherUpdatedAt.toISOString() : null,
    payload: JSON.parse(t.payload),
    todos: JSON.parse(t.todos),
    notes: t.notes,
    noteEntries: JSON.parse(t.noteEntries || '[]'),
    feedback: JSON.parse(t.feedback || '{}'),
    dayFeedback: JSON.parse(t.dayFeedback || '{}'),
    flightInfo: JSON.parse(t.flightInfo || '[]'),
    documents: JSON.parse(t.documents || '[]'),
    savedAt: t.createdAt.toISOString(),
  };
}
