import type { Metadata } from 'next';
import { db } from '@/db';
import { sharedTrips } from '@/db/schema';
import { eq } from 'drizzle-orm';

// The shared-trip page is a client component, so its link preview is set here.
// Without this, a shared itinerary shares the generic site card instead of
// naming the trip.

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  let trip: { title: string | null; destination: string | null } | null = null;
  try {
    const [row] = await db
      .select({ title: sharedTrips.title, destination: sharedTrips.destination })
      .from(sharedTrips)
      .where(eq(sharedTrips.id, params.id))
      .limit(1);
    trip = row || null;
  } catch { /* fall back to a generic card */ }

  const destination = trip?.destination || trip?.title || null;
  const title = destination ? `${destination} — shared itinerary` : 'Shared itinerary — Jalan';
  const description = destination
    ? `A day-by-day ${destination} itinerary planned with Jalan, with weather, transport, packing tips and daily route maps.`
    : 'A day-by-day itinerary planned with Jalan, with weather, transport, packing tips and daily route maps.';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `/share/${params.id}`,
      siteName: 'Jalan',
      type: 'article',
    },
    twitter: { card: 'summary', title, description },
  };
}

export default function SharedTripLayout({ children }: { children: React.ReactNode }) {
  return children;
}
