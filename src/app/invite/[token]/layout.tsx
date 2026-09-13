import type { Metadata } from 'next';
import { loadInvitePreview } from '@/lib/invite-lookup';

// The invite page itself is a client component, so its link preview is set here.
// Without this, an invite URL shares the generic "Jalan — Your AI Travel
// Companion" card and gives no hint that it is an invitation to a specific trip.

export async function generateMetadata({
  params,
}: {
  params: { token: string };
}): Promise<Metadata> {
  const preview = await loadInvitePreview(params.token);

  if (!preview) {
    // Unknown or expired token — still say what the link is.
    return {
      title: 'Trip invitation — Jalan',
      description: 'You have been invited to collaborate on a trip in Jalan.',
      openGraph: {
        title: 'Trip invitation — Jalan',
        description: 'You have been invited to collaborate on a trip in Jalan.',
        url: `/invite/${params.token}`,
        siteName: 'Jalan',
        type: 'website',
      },
      twitter: {
        card: 'summary',
        title: 'Trip invitation — Jalan',
        description: 'You have been invited to collaborate on a trip in Jalan.',
      },
    };
  }

  const title = preview.inviterName
    ? `${preview.inviterName} invited you to ${preview.destination}`
    : `You're invited to ${preview.destination}`;
  const description = `Join the ${preview.destination} trip (${preview.dates}) on Jalan. Comment on the plan, suggest changes, and follow the itinerary together.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `/invite/${params.token}`,
      siteName: 'Jalan',
      type: 'website',
    },
    twitter: { card: 'summary', title, description },
  };
}

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
