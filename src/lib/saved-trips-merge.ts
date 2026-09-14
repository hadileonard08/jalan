import type { SavedTrip } from './chat-state';

// Reconciles the local trip list with what the server has.
//
// The server decides *membership and order* — that is what makes a trip someone
// just shared with you appear. Local state still wins for the fields a user can
// edit offline (todos, notes, comments), so an unsynced edit is never clobbered.
//
// Before this, the refresh only mapped over trips already in state, so a trip
// shared with you while the app was open never showed up until a full reload.
export function mergeServerTrips(local: SavedTrip[], server: SavedTrip[]): SavedTrip[] {
  const localById = new Map(local.map((trip) => [trip.id, trip]));

  return server.map((fresh) => {
    const existing = localById.get(fresh.id);
    // Newly shared with this user — take the server's copy as-is.
    if (!existing) return fresh;

    return {
      ...existing,
      weatherAlert: fresh.weatherAlert,
      weatherSnapshot: fresh.weatherSnapshot,
      weatherUpdatedAt: fresh.weatherUpdatedAt,
      payload: fresh.payload,
    };
  });
}
