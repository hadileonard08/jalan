'use client';

import { useEffect, useState, useRef, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { List, X, Bookmark, Check, Loader2 } from 'lucide-react';
import WalkersIcon from '@/components/WalkersIcon';
import { useUser, SignInButtonWrapper } from '@/components/AuthProvider';
import type { DayTransport } from '@/agents/transport';

const DailyRouteMap = dynamic(() => import('@/components/chat/DailyRouteMap'), {
  ssr: false,
  loading: () => <div className="w-full h-72 rounded-2xl bg-gray-100 dark:bg-gray-700 animate-pulse" />,
});

interface SharedTripData {
  id: string;
  title: string;
  destination: string | null;
  itinerary: string;
  payload: any;
  createdAt: string;
}

function slug(text: any): string {
  const str = typeof text === 'string' ? text : Array.isArray(text) ? text.join('') : String(text || '');
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Reusable markdown renderer with consistent component overrides.
function ItineraryMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={slug(children)} className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-2 mb-1">{children}</h1>,
          h2: ({ children }) => {
            const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children || '');
            const isDayHeading = /^Day\s+\d+/i.test(text);
            return (
              <h2
                id={slug(children)}
                className={`font-bold mt-0 mb-2 ${isDayHeading ? 'text-lg text-blue-700 flex items-center gap-2' : 'text-lg text-gray-900 dark:text-gray-100'}`}
              >
                {isDayHeading && <span className="inline-flex items-center justify-center w-7 h-7 bg-blue-600 text-white text-sm rounded-lg font-bold">{text.match(/Day\s+(\d+)/i)?.[1] || ''}</span>}
                {isDayHeading ? text.replace(/^Day\s+\d+\s*[:\-—]?\s*/i, '') : children}
              </h2>
            );
          },
          h3: ({ children }) => <h3 id={slug(children)} className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-3 mb-1">{children}</h3>,
          p: ({ children }) => <p className="text-gray-700 dark:text-gray-300 leading-relaxed my-2">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc list-inside text-gray-700 dark:text-gray-300 my-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside text-gray-700 dark:text-gray-300 my-2 space-y-0.5">{children}</ol>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800">{children}</a>,
          img: ({ src, alt }) => (
            <figure className="my-3">
              {src && <img src={src} alt={alt || ''} className="rounded-xl shadow-md w-full" loading="lazy" />}
              {alt && <figcaption className="text-xs text-gray-400 dark:text-gray-500 text-center mt-1">{alt}</figcaption>}
            </figure>
          ),
          blockquote: ({ children }) => <blockquote className="border-l-4 border-gray-200 dark:border-gray-700 pl-3 text-gray-600 dark:text-gray-400 italic my-2">{children}</blockquote>,
          hr: () => <hr className="border-gray-100 dark:border-gray-800 my-4" />,
          table: ({ children }) => <table className="w-full text-sm border-collapse my-3">{children}</table>,
          th: ({ children }) => <th className="border border-gray-200 dark:border-gray-700 px-2 py-1 text-left font-semibold bg-gray-50 dark:bg-gray-800">{children}</th>,
          td: ({ children }) => <td className="border border-gray-200 dark:border-gray-700 px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Split itinerary markdown into sections by "Day X" headings so each day
// can be rendered as a visual card with a colored left border.
function renderItineraryMarkdown(markdown: string): React.ReactNode {
  const dayHeadingRegex = /^(#{2,3})\s+(Day\s+\d+.*)$/gm;
  const matches: { index: number; line: string; level: number; title: string }[] = [];
  let m;
  while ((m = dayHeadingRegex.exec(markdown)) !== null) {
    matches.push({ index: m.index, line: m[0], level: m[1].length, title: m[2] });
  }

  if (matches.length === 0) {
    return <ItineraryMarkdown>{markdown}</ItineraryMarkdown>;
  }

  const sections: React.ReactNode[] = [];

  const beforeFirst = markdown.substring(0, matches[0].index).trim();
  if (beforeFirst) {
    sections.push(<ItineraryMarkdown key="intro">{beforeFirst}</ItineraryMarkdown>);
  }

  matches.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const sectionContent = markdown.substring(start, end).trim();

    sections.push(
      <div
        key={`day-${i}`}
        id={slug(match.title)}
        className="day-card bg-white dark:bg-gray-800 border-l-4 border-blue-400 rounded-r-xl pl-4 pr-3 py-3 my-4 scroll-mt-20"
      >
        <ItineraryMarkdown>{sectionContent}</ItineraryMarkdown>
      </div>
    );
  });

  return <div className="space-y-1">{sections}</div>;
}

// Extract headings from itinerary markdown for the section navigator.
function extractHeadings(markdown: string): { id: string; label: string; level: number }[] {
  const headings: { id: string; label: string; level: number }[] = [];
  const regex = /^(#{1,3})\s+(.+)$/gm;
  let m;
  while ((m = regex.exec(markdown)) !== null) {
    const level = m[1].length;
    const label = m[2].trim();
    headings.push({ id: slug(label), label, level });
  }
  return headings;
}

// Inline day-toggle + Leaflet map for the shared trip page.
function SharedDailyRouteMap({ days }: { days: DayTransport[] }) {
  const [activeDay, setActiveDay] = useState(days[0]?.day || '1');
  const activeDayData = days.find((d) => d.day === activeDay) || days[0];
  if (!activeDayData) return null;
  return (
    <div className="mb-3">
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
        {days.map((d) => (
          <button
            key={d.day}
            onClick={() => setActiveDay(d.day)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              activeDay === d.day
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 hover:border-blue-300'
            }`}
          >
            Day {d.day}
          </button>
        ))}
      </div>
      <DailyRouteMap waypoints={activeDayData.waypoints} polyline={activeDayData.polyline} />
    </div>
  );
}

export default function SharedTripPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 dark:bg-gray-900" />}>
      <SharedTripPage />
    </Suspense>
  );
}

function SharedTripPage() {
  const params = useParams();
  const id = params.id as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [trip, setTrip] = useState<SharedTripData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    async function fetchTrip() {
      try {
        const res = await fetch(`/api/share/${id}`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to load trip');
        }
        const data = await res.json();
        setTrip(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load trip');
      } finally {
        setLoading(false);
      }
    }
    fetchTrip();
  }, [id]);

  // Auto-save when action=save is present and user is authenticated.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !trip || saving || saved) return;
    if (searchParams.get('action') !== 'save') return;

    setSaving(true);
    fetch('/api/saved-trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: '',
        destination: trip.destination || trip.title || 'Shared Trip',
        dates: trip.payload?.entities?.startDate
          ? `${trip.payload.entities.startDate}${trip.payload.entities.endDate ? ` - ${trip.payload.entities.endDate}` : ''}`
          : 'Dates TBD',
        payload: trip.payload,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to save');
        return res.json();
      })
      .then(() => {
        setSaved(true);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 4000);
        // Clear the query parameter.
        router.replace(`/share/${id}`);
      })
      .catch(() => {
        setSaving(false);
      });
  }, [isLoaded, isSignedIn, trip, searchParams, router, id, saving, saved]);

  const handleSaveTrip = async () => {
    if (!trip || saving || saved) return;
    setSaving(true);
    try {
      const res = await fetch('/api/saved-trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '',
          destination: trip.destination || trip.title || 'Shared Trip',
          dates: trip.payload?.entities?.startDate
            ? `${trip.payload.entities.startDate}${trip.payload.entities.endDate ? ` - ${trip.payload.entities.endDate}` : ''}`
            : 'Dates TBD',
          payload: trip.payload,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 4000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-500 dark:text-gray-400 text-sm">Loading trip...</p>
        </div>
      </div>
    );
  }

  if (error || !trip) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <WalkersIcon className="text-gray-300 dark:text-gray-600 mx-auto mb-4" size={48} />
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Trip not found</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">{error || 'This shared trip may have been deleted or the link is invalid.'}</p>
          <a href="/" className="inline-block mt-4 text-blue-600 hover:text-blue-800 text-sm font-medium">
            Plan your own trip →
          </a>
        </div>
      </div>
    );
  }

  // Build section headings for the navigator.
  const mdHeadings = trip.itinerary ? extractHeadings(trip.itinerary) : [];
  const payloadHeadings: { id: string; label: string; level: number }[] = [];
  if (trip.payload?.weather) payloadHeadings.push({ id: 'section-weather', label: 'Weather Outlook', level: 2 });
  if (trip.payload?.transportPlan) payloadHeadings.push({ id: 'section-transport', label: 'Transport & Getting Around', level: 2 });
  if (trip.payload?.packingTips) payloadHeadings.push({ id: 'section-packing', label: 'Packing Suggestions', level: 2 });
  if (trip.payload?.deals?.length) payloadHeadings.push({ id: 'section-deals', label: 'Flight Deals', level: 2 });
  if (trip.payload?.routeLinks?.length) payloadHeadings.push({ id: 'section-routes', label: 'Daily Routes', level: 2 });
  const headings = [...mdHeadings, ...payloadHeadings];

  const jumpTo = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      const headerHeight = 60;
      const y = el.getBoundingClientRect().top + window.scrollY - headerHeight;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
    setSectionsOpen(false);
  };

  const sectionButtons = headings.map((h) => {
    const isDay = /^day\s+\d+/i.test(h.label);
    const dayNumber = h.label.match(/Day\s+(\d+)/i)?.[1] || '';
    const cleanLabel = isDay ? h.label.replace(/^Day\s+\d+\s*[:\-—]?\s*/i, '') : h.label;
    return (
      <button
        key={h.id}
        onClick={() => jumpTo(h.id)}
        className="w-full text-left text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 py-1.5 px-2 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors truncate"
        title={h.label}
      >
        {isDay ? <span><span className="text-gray-400 dark:text-gray-600 mr-1.5">{dayNumber}.</span>{cleanLabel}</span> : h.label}
      </button>
    );
  });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WalkersIcon className="text-blue-600" size={24} />
            <span className="font-bold text-lg text-gray-900 dark:text-gray-100">Jalan</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyLink}
              className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1.5"
            >
              {copied ? '✓ Copied!' : '🔗 Copy link'}
            </button>
            <a
              href="/"
              className="text-sm bg-blue-600 text-white font-medium px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Plan your own trip
            </a>
          </div>
        </div>
      </header>

      {/* Trip content + section nav */}
      <div className="max-w-5xl mx-auto flex">
        {/* Main content */}
        <main ref={scrollRef} className="flex-1 min-w-0 px-4 py-6">
          {/* Trip header */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{trip.title}</h1>
            {trip.destination && (
              <p className="text-gray-500 dark:text-gray-400 text-sm flex items-center gap-1">
                📍 {trip.destination}
              </p>
            )}
            <p className="text-gray-400 dark:text-gray-500 text-xs mt-2">
              Shared {new Date(trip.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>

          {/* Itinerary */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
            {renderItineraryMarkdown(trip.itinerary)}
          </div>

          {/* Payload sections — weather, transport, packing, deals, routes */}
          {trip.payload && (
            <div className="mt-6 space-y-4">
              {/* Weather */}
              {trip.payload.weather && (
                <div id="section-weather" className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-2xl p-5 scroll-mt-20">
                  <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300 font-semibold mb-2">
                    🌤️ Weather Outlook
                  </div>
                  <div className="text-sm text-blue-900 dark:text-blue-100">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({ children }) => <p className="font-semibold text-blue-900 dark:text-blue-100 mt-2 mb-1">{children}</p>,
                        h2: ({ children }) => <p className="font-semibold text-blue-900 dark:text-blue-100 mt-2 mb-1">{children}</p>,
                        h3: ({ children }) => <p className="font-medium text-blue-800 dark:text-blue-300 mt-2 mb-1">{children}</p>,
                        p: ({ children }) => <p className="leading-relaxed my-1">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold text-blue-900 dark:text-blue-100">{children}</strong>,
                        ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                      }}
                    >
                      {typeof trip.payload.weather === 'string' ? trip.payload.weather : JSON.stringify(trip.payload.weather, null, 2)}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Transport */}
              {trip.payload.transportPlan && (trip.payload.transportPlan.cityTransitTips || trip.payload.transportPlan.estimatedCosts) && (
                <div id="section-transport" className="bg-green-50 dark:bg-green-950/40 border border-green-100 dark:border-green-900/50 rounded-2xl p-5 scroll-mt-20">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-300 font-semibold mb-2">
                    🗺️ Transport & Getting Around
                  </div>
                  {trip.payload.transportPlan.cityTransitTips && (
                    <div className="text-sm text-green-900 dark:text-green-100 mb-3">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: ({ children }) => <p className="font-semibold text-green-900 dark:text-green-100 mt-2 mb-1">{children}</p>,
                          h2: ({ children }) => <p className="font-semibold text-green-900 dark:text-green-100 mt-2 mb-1">{children}</p>,
                          h3: ({ children }) => <p className="font-medium text-green-800 dark:text-green-300 mt-2 mb-1">{children}</p>,
                          p: ({ children }) => <p className="leading-relaxed my-1">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold text-green-900 dark:text-green-100">{children}</strong>,
                          ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                        }}
                      >
                        {trip.payload.transportPlan.cityTransitTips}
                      </ReactMarkdown>
                    </div>
                  )}
                  {trip.payload.transportPlan.estimatedCosts && (
                    <div className="text-sm text-green-900 dark:text-green-100">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold text-green-900 dark:text-green-100">{children}</strong>,
                          ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                        }}
                      >
                        {trip.payload.transportPlan.estimatedCosts}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              )}

              {/* Packing */}
              {trip.payload.packingTips && (
                <div id="section-packing" className="bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/50 rounded-2xl p-5 scroll-mt-20">
                  <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold mb-2">
                    🎒 Packing Suggestions
                  </div>
                  <div className="text-sm text-amber-900 dark:text-amber-100">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({ children }) => <p className="font-semibold text-amber-900 dark:text-amber-100 mt-2 mb-1">{children}</p>,
                        h2: ({ children }) => <p className="font-semibold text-amber-900 dark:text-amber-100 mt-2 mb-1">{children}</p>,
                        h3: ({ children }) => <p className="font-medium text-amber-800 dark:text-amber-300 mt-2 mb-1">{children}</p>,
                        p: ({ children }) => <p className="leading-relaxed my-1">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold text-amber-900 dark:text-amber-100">{children}</strong>,
                        ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                      }}
                    >
                      {trip.payload.packingTips}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Deals */}
              {trip.payload.deals && trip.payload.deals.length > 0 && (
                <div id="section-deals" className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 scroll-mt-20">
                  <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-semibold mb-3">
                    ✈️ Flight Deals
                  </div>
                  <div className="grid gap-2">
                    {trip.payload.deals.slice(0, 5).map((deal: any, i: number) => (
                      <div key={i} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                            {deal.originCode} → {deal.destinationCode}
                          </div>
                          <div className="text-blue-600 font-semibold text-sm">
                            {Number(deal.pointsRequired).toLocaleString()} pts
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          {deal.airline} · {deal.cabin}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Route links */}
              {trip.payload.routeLinks && trip.payload.routeLinks.length > 0 && (
                <div id="section-routes" className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 scroll-mt-20">
                  <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-semibold mb-3">
                    🗺️ Daily Routes
                  </div>

                  {trip.payload.transportPlan?.days?.length > 0 && (
                    <SharedDailyRouteMap days={trip.payload.transportPlan.days} />
                  )}

                  <div className="grid gap-2 mt-3">
                    {trip.payload.routeLinks.map((link: any, i: number) => (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border border-gray-200 dark:border-gray-700 rounded-lg p-3 hover:border-blue-300 transition-colors no-underline"
                      >
                        <div className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                          Day {link.day}: {link.title || 'Route'}
                        </div>
                        <div className="text-xs text-blue-600 mt-1">Open in Google Maps →</div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="text-center mt-8 mb-4 space-y-3">
            {/* Save to My One Stop CTA */}
            {isLoaded && isSignedIn ? (
              <button
                onClick={handleSaveTrip}
                disabled={saving || saved}
                className={`inline-flex items-center gap-2 font-medium px-5 py-2.5 rounded-xl transition-colors ${
                  saved
                    ? 'bg-green-600 text-white cursor-default'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                } disabled:opacity-70`}
              >
                {saving ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : saved ? (
                  <Check size={20} />
                ) : (
                  <Bookmark size={20} />
                )}
                {saving ? 'Saving...' : saved ? 'Saved to One Stop!' : 'Save to My One Stop'}
              </button>
            ) : isLoaded && !isSignedIn ? (
              <SignInButtonWrapper fallbackRedirectUrl={`${window.location.pathname}?action=save`}>
                <span className="inline-flex items-center gap-2 bg-blue-600 text-white font-medium px-5 py-2.5 rounded-xl hover:bg-blue-700 transition-colors cursor-pointer">
                  <Bookmark size={20} />
                  Sign in to Save to One Stop
                </span>
              </SignInButtonWrapper>
            ) : null}

            <p className="text-gray-400 dark:text-gray-500 text-sm">Want a trip like this?</p>
            <a
              href="/"
              className="inline-flex items-center gap-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-medium px-5 py-2.5 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <WalkersIcon className="text-gray-600 dark:text-gray-300" size={20} />
              Plan your own trip with Jalan
            </a>
          </div>
        </main>

        {/* Desktop section nav rail */}
        {headings.length >= 2 && (
          <nav className="hidden lg:flex flex-col w-48 border-l border-gray-100 dark:border-gray-800 py-6 px-2 h-screen sticky top-0 overflow-hidden flex-shrink-0">
            <div className="overflow-y-auto flex-1 space-y-0.5">
              {sectionButtons}
            </div>
          </nav>
        )}

        {/* Mobile floating button */}
        {headings.length >= 2 && (
          <button
            onClick={() => setSectionsOpen(true)}
            className="lg:hidden fixed right-3 bottom-6 z-30 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 rounded-full shadow-md p-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            title="Jump to section"
          >
            <List size={20} />
          </button>
        )}

        {/* Mobile drawer */}
        {sectionsOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex justify-end">
            <div className="absolute inset-0 bg-black/20" onClick={() => setSectionsOpen(false)} />
            <nav className="relative w-56 bg-white dark:bg-gray-900 shadow-xl h-full flex flex-col overflow-y-auto">
              <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Sections</span>
                <button onClick={() => setSectionsOpen(false)} className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-gray-100">
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {sectionButtons}
              </div>
            </nav>
          </div>
        )}
      </div>

      {/* Success toast */}
      {showToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-green-600 text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 animate-in fade-in slide-in-from-bottom duration-300">
          <Check size={18} />
          <span className="text-sm font-medium">Trip saved to your One Stop panel!</span>
        </div>
      )}
    </div>
  );
}
