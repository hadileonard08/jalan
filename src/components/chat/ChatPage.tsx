'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Plane, Loader2, History, Plus, LogIn, MapPin, Calendar, Sun, Wind, Droplets, Briefcase, Trash2, Bookmark, Map, Menu, X, List, Navigation, Share2, Image as ImageIcon } from 'lucide-react';
import { useUser, SignInButtonWrapper, UserButtonWrapper } from '@/components/AuthProvider';
import { getAirlineBookingUrl } from '@/lib/airline-booking';
import useSWR, { mutate } from 'swr';
import type { ChatMessageUI, ChatPayload, SavedTrip, RouteLink } from '@/lib/chat-state';
import OneStopPanel from './OneStopPanel';
import ThemeToggle from '@/components/ThemeToggle';
import WalkersIcon from '@/components/WalkersIcon';

interface Conversation {
  id: string;
  title: string | null;
  updatedAt: string;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function slug(children: any): string {
  const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children || '');
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractHeadings(markdown: string): { id: string; label: string; level: number }[] {
  const lines = markdown.split('\n');
  const headings: { id: string; label: string; level: number }[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      const label = m[2].trim();
      headings.push({ id: slug(label), label, level: m[1].length });
    }
  }
  return headings;
}

function formatDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Shared markdown component overrides for payload cards (weather, transport, packing).
// Renders headings as styled paragraphs so ### and ** don't show as raw markdown.
const payloadMarkdownComponents = {
  h1: ({ children }: any) => <p className="font-semibold mt-2 mb-1">{children}</p>,
  h2: ({ children }: any) => <p className="font-semibold mt-2 mb-1">{children}</p>,
  h3: ({ children }: any) => <p className="font-medium mt-2 mb-1">{children}</p>,
  p: ({ children }: any) => <p className="leading-relaxed my-1">{children}</p>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }: any) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
};

function WeatherCard({ weather }: { weather?: any }) {
  if (!weather) return null;
  const summary = typeof weather === 'string' ? weather : JSON.stringify(weather, null, 2);
  return (
    <div id="section-weather" className="bg-white/90 dark:bg-[#1c1c1e] border border-black/[0.08] dark:border-white/[0.1] rounded-2xl p-5 my-4 shadow-sm scroll-mt-24">
      <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300 font-semibold mb-2">
        <Sun size={18} /> Weather Outlook
      </div>
      <div className="text-sm text-blue-900 dark:text-blue-100">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={payloadMarkdownComponents}>{summary}</ReactMarkdown>
      </div>
    </div>
  );
}

function PackingCard({ packingTips }: { packingTips?: string }) {
  if (!packingTips) return null;
  return (
    <div id="section-packing" className="bg-white/90 dark:bg-[#1c1c1e] border border-black/[0.08] dark:border-white/[0.1] rounded-2xl p-5 my-4 shadow-sm scroll-mt-24">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold mb-2">
        <Briefcase size={18} /> Packing Suggestions
      </div>
      <div className="text-sm text-amber-900 dark:text-amber-100">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={payloadMarkdownComponents}>{packingTips}</ReactMarkdown>
      </div>
    </div>
  );
}

function formatDuration(minutes?: number | null): string {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatStops(stops?: number | null): string {
  if (stops === null || stops === undefined) return '';
  if (stops === 0) return 'Nonstop';
  if (stops === 1) return '1 stop';
  return `${stops} stops`;
}

function DealsList({ deals }: { deals?: any[] }) {
  if (!deals || deals.length === 0) return null;

  // Show the top 5 lowest-mileage deals, including duration and stops.
  const topDeals = [...deals]
    .sort((a, b) => (a.pointsRequired || Infinity) - (b.pointsRequired || Infinity))
    .slice(0, 5);

  return (
    <div id="section-deals" className="my-3 scroll-mt-24">
      <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-semibold mb-2">
        <Plane size={18} /> Points Flight Deals
      </div>
      <div className="grid gap-2">
        {topDeals.map((deal, i) => {
          const bookingUrl = getAirlineBookingUrl(
            deal.airline || '',
            deal.originCode || '',
            deal.destinationCode || '',
            deal.departureDate
          );
          return (
            <a
              key={i}
              href={bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-white dark:bg-[#2c2c2e] border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shadow-sm hover:border-blue-500/40 hover:shadow-[0_8px_30px_rgba(0,0,0,0.1)] active:scale-95 transition-all duration-200 ease-out no-underline"
            >
              <div>
                <div className="font-semibold text-gray-900 dark:text-gray-100">
                  {deal.originCode} → {deal.destinationCode}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {deal.airline} · {deal.cabin} · {formatDate(deal.departureDate)}
                  {deal.returnDate ? ` - ${formatDate(deal.returnDate)}` : ''}
                </div>
                <div className="text-[13px] text-gray-400 dark:text-gray-500 mt-1">
                  {formatDuration(deal.duration)}
                  {deal.duration && deal.stops !== null && deal.stops !== undefined ? ' · ' : ''}
                  {formatStops(deal.stops)}
                </div>
              </div>
              <div className="text-right flex flex-col items-end gap-1">
                <div className="text-lg font-bold text-blue-600">
                  {Number(deal.pointsRequired).toLocaleString()} pts
                </div>
                {deal.taxesAndFees ? (
                  <div className="text-[13px] text-gray-500">+ ${Number(deal.taxesAndFees).toFixed(2)} taxes</div>
                ) : null}
                <div className="text-[13px] text-blue-600">Book on airline site →</div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function RouteLinks({ routeLinks }: { routeLinks?: RouteLink[] }) {
  if (!routeLinks || routeLinks.length === 0) return null;
  return (
    <div id="section-routes" className="my-3 scroll-mt-24">
      <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-semibold mb-2">
        <Map size={18} /> Daily Routes
      </div>
      <div className="grid gap-2">
        {routeLinks.map((link, i) => (
          <a
            key={i}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between bg-white dark:bg-[#2c2c2e] border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-4 hover:border-blue-500/40 hover:shadow-[0_8px_30px_rgba(0,0,0,0.08)] active:scale-95 transition-all duration-200 ease-out no-underline"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-gray-900 dark:text-gray-100">
                Day {link.day}{link.title ? `: ${link.title}` : ''}
              </div>
              {link.highlights && (
                <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">{link.highlights}</div>
              )}
            </div>
            <div className="text-[13px] text-blue-600 font-medium flex-shrink-0 ml-2">Open in Google Maps →</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function TransportCard({ transportPlan }: { transportPlan?: any }) {
  if (!transportPlan) return null;
  const { cityTransitTips, estimatedCosts } = transportPlan;
  if (!cityTransitTips && !estimatedCosts) return null;

  return (
    <div id="section-transport" className="my-4 bg-white/90 dark:bg-[#1c1c1e] border border-black/[0.08] dark:border-white/[0.1] rounded-2xl p-5 shadow-sm scroll-mt-24">
      <div className="flex items-center gap-2 text-green-700 dark:text-green-300 font-semibold mb-2">
        <Navigation size={18} /> Transport & Getting Around
      </div>

      {cityTransitTips && (
        <div className="text-sm text-green-900 dark:text-green-100 mb-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={payloadMarkdownComponents}>{cityTransitTips}</ReactMarkdown>
        </div>
      )}

      {estimatedCosts && (
        <div className="text-sm text-green-900 dark:text-green-100">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={payloadMarkdownComponents}>{estimatedCosts}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// Loading step indicator — shows which pipeline steps have completed.
const PIPELINE_STEPS = [
  { status: 'Thinking...', label: 'Understanding your request', icon: '🧠' },
  { status: 'Asking a quick question...', label: 'Clarifying details', icon: '💬' },
  { status: 'Looking that up...', label: 'Finding deals', icon: '✈️' },
  { status: 'Planning your trip...', label: 'Building your itinerary', icon: '🗺️' },
  { status: 'Double-checking...', label: 'Verifying landmarks', icon: '✓' },
  { status: 'Adding maps, transport & images...', label: 'Adding trip details', icon: '🗺️' },
  { status: 'Finalizing...', label: 'Finalizing', icon: '✨' },
];

function pipelineStatusIndex(status?: string): number {
  return PIPELINE_STEPS.findIndex((step) => step.status === status);
}

function LoadingSteps({ currentStatus }: { currentStatus?: string }) {
  const currentIdx = PIPELINE_STEPS.findIndex(s => s.status === currentStatus);
  // If we don't recognize the status, show a generic spinner.
  if (currentIdx === -1) {
    return (
      <div className="flex items-center gap-2 text-sm text-blue-600 animate-pulse py-1">
        <Loader2 size={14} className="animate-spin" />
        {currentStatus || 'Working...'}
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white/75 dark:bg-[#1c1c1e]/75 border border-black/[0.05] dark:border-white/[0.1] px-4 py-3 shadow-sm space-y-1.5">
      {PIPELINE_STEPS.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div
            key={i}
            className={`flex items-center gap-2.5 text-sm transition-all ${
              isDone ? 'text-gray-400 dark:text-gray-500' : isActive ? 'text-blue-600' : 'text-gray-300 dark:text-gray-600'
            }`}
          >
            <span className={`flex-shrink-0 w-5 h-5 flex items-center justify-center text-[13px] rounded-full ${
              isDone ? 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400' : isActive ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 animate-pulse' : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
            }`}>
              {isDone ? '✓' : step.icon}
            </span>
            <span className={isActive ? 'font-medium' : ''}>{step.label}</span>
            {isActive && <Loader2 size={12} className="animate-spin ml-auto" />}
          </div>
        );
      })}
    </div>
  );
}

function EnrichmentProgress() {
  const items = [
    { label: 'Photos', icon: ImageIcon },
    { label: 'Daily routes', icon: Map },
    { label: 'Transport', icon: Navigation },
  ];
  return (
    <div className="grid grid-cols-3 gap-2" aria-label="Adding trip details">
      {items.map(({ label, icon: Icon }) => (
        <div key={label} className="rounded-xl bg-white/75 dark:bg-[#1c1c1e]/75 border border-black/[0.05] dark:border-white/[0.1] px-3 py-3 flex flex-col sm:flex-row items-center gap-2 text-center sm:text-left shadow-sm">
          <span className="w-8 h-8 rounded-full bg-blue-600/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <Icon size={16} />
          </span>
          <span className="text-[13px] sm:text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
          <Loader2 size={13} className="animate-spin text-blue-500 sm:ml-auto" />
        </div>
      ))}
    </div>
  );
}

// Split itinerary markdown into sections by "Day X" headings so each day
// can be rendered as a visual card with a colored left border.
function renderItineraryMarkdown(markdown: string, isEnriching = false): React.ReactNode {
  // Find all "## Day X" or "### Day X" heading positions.
  const dayHeadingRegex = /^(#{2,3})\s+(Day\s+(\d+)(?:\s*[:\-—]\s*)?(.*))$/gm;
  const matches: { index: number; line: string; level: number; title: string; day: string; label: string }[] = [];
  let m;
  while ((m = dayHeadingRegex.exec(markdown)) !== null) {
    matches.push({ index: m.index, line: m[0], level: m[1].length, title: m[2], day: m[3], label: m[4].trim() });
  }

  // If no day headings, render as normal markdown.
  if (matches.length === 0) {
    return <ItineraryMarkdown>{markdown}</ItineraryMarkdown>;
  }

  const beforeFirst = markdown.substring(0, matches[0].index).trim();

  return (
    <div className="space-y-5">
      {beforeFirst ? (
        <section className="rounded-2xl bg-white/70 dark:bg-[#1c1c1e]/70 border border-black/[0.05] dark:border-white/[0.1] px-5 py-5 md:px-7 md:py-6 shadow-sm">
          <ItineraryMarkdown>{beforeFirst}</ItineraryMarkdown>
        </section>
      ) : null}
      <div className="space-y-5">
        {matches.map((match, i) => {
          const contentStart = match.index + match.line.length;
          const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
          const sectionContent = markdown.substring(contentStart, end).trim();
          const hasImage = /!\[[^\]]*\]\(https?:\/\//i.test(sectionContent);
          const displayContent = sectionContent.replace(/!\[IMAGE:\s*[^\]]+\](?:\([^)]*\))?/gi, '').trim();
          return (
            <article
              key={`day-${match.day}-${i}`}
              id={slug(match.title)}
              className="day-card rounded-2xl scroll-mt-24 overflow-hidden"
            >
              <header className="px-5 pt-5 pb-1 md:px-7 md:pt-6">
                <div className="text-[13px] font-semibold tracking-[0.14em] uppercase text-blue-600 dark:text-blue-400 mb-2">Day {match.day}</div>
                <h2 className="text-xl md:text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{match.label || `Day ${match.day}`}</h2>
              </header>
              <div className="px-5 pb-5 md:px-7 md:pb-7">
                {!hasImage ? (
                  isEnriching ? (
                    <div className="my-5 aspect-video rounded-2xl bg-gray-100 dark:bg-[#2c2c2e] overflow-hidden relative" aria-label="Finding a relevant photo">
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/60 dark:via-white/[0.06] to-transparent -translate-x-full animate-pulse" />
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500 gap-2">
                        <ImageIcon size={18} /> Finding a relevant photo
                      </div>
                    </div>
                  ) : (
                    <div className="my-5 rounded-xl bg-gray-100/80 dark:bg-[#2c2c2e]/80 px-4 py-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                      <ImageIcon size={17} /> No verified photo available
                    </div>
                  )
                ) : null}
                <ItineraryMarkdown>{displayContent}</ItineraryMarkdown>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// Reusable markdown renderer with consistent component overrides.
function ItineraryMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-base dark:prose-invert max-w-none overflow-x-auto prose-p:leading-7 prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-headings:tracking-tight">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={slug(children)} className="text-2xl md:text-3xl font-semibold tracking-tight text-gray-950 dark:text-white mt-2 mb-3">{children}</h1>,
          h2: ({ children }) => {
            const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children || '');
            const isDayHeading = /^Day\s+\d+/i.test(text);
            return (
              <h2
                id={slug(children)}
                className={`font-semibold tracking-tight mt-0 mb-4 ${isDayHeading ? 'text-xl md:text-2xl text-gray-950 dark:text-white flex items-center gap-3' : 'text-xl text-gray-950 dark:text-white'}`}
              >
                {isDayHeading && <span className="inline-flex items-center justify-center w-8 h-8 bg-blue-600 text-white text-sm rounded-full font-semibold shadow-sm">{text.match(/Day\s+(\d+)/i)?.[1] || ''}</span>}
                {isDayHeading ? text.replace(/^Day\s+\d+\s*[:\-—]?\s*/i, '') : children}
              </h2>
            );
          },
          h3: ({ children }) => <h3 id={slug(children)} className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-3 mb-1">{children}</h3>,
          img: ({ src, alt }) => (
            <figure className="my-5">
              <img src={src} alt={alt} loading="lazy" className="w-full aspect-video object-cover rounded-2xl bg-gray-100 dark:bg-gray-800" />
              {alt && alt !== 'IMAGE' && <figcaption className="text-[13px] text-gray-500 dark:text-gray-400 mt-2 text-center">{alt}</figcaption>}
            </figure>
          ),
          table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-[13px]">{children}</table></div>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700 underline">{children}</a>,
          strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
          ul: ({ children }) => <ul className="space-y-0.5 my-2">{children}</ul>,
          li: ({ children }) => <li className="text-gray-700 dark:text-gray-300">{children}</li>,
        }}
      >{children}</ReactMarkdown>
    </div>
  );
}

function stripPayloadSections(markdown: string, payload?: ChatPayload): string {
  if (!payload?.packingTips) return markdown;
  return markdown.replace(/\n+---\s*\n+##\s*(?:🧳\s*)?Packing Tips[\s\S]*$/i, '').trim();
}

function MessageContent({ message, onSaveTrip, onShare, shareUrl, isSignedIn }: { message: ChatMessageUI; onSaveTrip?: (payload: ChatPayload) => void; onShare?: () => void; shareUrl?: string; isSignedIn: boolean }) {
  if (message.role === 'user') {
    return <div className="whitespace-pre-wrap">{message.content}</div>;
  }

  const content = stripPayloadSections(message.content, message.payload);

  return (
    <div className="space-y-5">
      {message.status ? <LoadingSteps currentStatus={message.status} /> : null}
      {message.status?.startsWith('Adding maps') ? <EnrichmentProgress /> : null}
      {content ? renderItineraryMarkdown(content, message.status?.startsWith('Adding maps')) : null}
      {message.payload ? <RichPayload payload={message.payload} onSaveTrip={onSaveTrip} onShare={onShare} shareUrl={shareUrl} isSignedIn={isSignedIn} /> : null}
    </div>
  );
}

function RichPayload({ payload, onSaveTrip, onShare, shareUrl, isSignedIn }: { payload: ChatPayload; onSaveTrip?: (payload: ChatPayload) => void; onShare?: () => void; shareUrl?: string; isSignedIn: boolean }) {
  const hasSavableContent = payload.deals?.length || payload.itinerary || payload.packingTips;
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const saveButton = (
    <button
      onClick={() => onSaveTrip?.(payload)}
      className="flex items-center gap-1.5 min-h-11 text-[13px] font-medium text-blue-600 bg-blue-500/10 hover:bg-blue-500/15 px-4 py-2 rounded-xl active:scale-95 transition-all duration-200 ease-out"
    >
      <Bookmark size={14} /> Save to One Stop
    </button>
  );

  const handleShare = async () => {
    if (!onShare) return;
    setSharing(true);
    try {
      await onShare();
    } finally {
      setSharing(false);
    }
  };

  const handleCopyShareLink = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
  };

  const hasTripDetails = payload.weather || payload.transportPlan || payload.packingTips || payload.deals?.length || payload.routeLinks?.length;

  return (
    <section className="space-y-4">
      {hasTripDetails ? (
        <div className="flex items-end justify-between gap-4 pt-4">
          <div>
            <div className="text-[13px] font-semibold tracking-[0.14em] uppercase text-blue-600 dark:text-blue-400 mb-1.5">Trip details</div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Everything in one place</h2>
          </div>
        </div>
      ) : null}
      <div className="grid md:grid-cols-2 gap-4 [&>*]:my-0">
        <WeatherCard weather={payload.weather} />
        <PackingCard packingTips={payload.packingTips} />
      </div>
      <TransportCard transportPlan={payload.transportPlan} />
      <DealsList deals={payload.deals} />
      <RouteLinks routeLinks={payload.routeLinks} />
      {hasSavableContent ? (
        <div className="flex justify-end gap-2 flex-wrap pt-4 border-t border-black/[0.05] dark:border-white/[0.1]">
          {shareUrl ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                readOnly
                value={shareUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="text-[13px] text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 w-48 truncate"
              />
              <button
                onClick={handleCopyShareLink}
                className="flex items-center gap-1.5 min-h-11 text-[13px] font-medium text-blue-600 bg-blue-500/10 hover:bg-blue-500/15 px-4 py-2 rounded-xl active:scale-95 transition-all duration-200 ease-out"
              >
                {shareCopied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
          ) : (
            <button
              onClick={handleShare}
              disabled={sharing}
              className="flex items-center gap-1.5 min-h-11 text-[13px] font-medium text-gray-700 dark:text-gray-200 bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.07] dark:hover:bg-white/[0.12] px-4 py-2 rounded-xl active:scale-95 transition-all duration-200 ease-out disabled:opacity-50"
            >
              {sharing ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
              {sharing ? 'Creating...' : 'Share'}
            </button>
          )}
          {isSignedIn ? saveButton : (
            <SignInButtonWrapper mode="modal">
              {saveButton}
            </SignInButtonWrapper>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SidebarContent({
  conversations,
  activeConversationId,
  onLoadConversation,
  onNewChat,
  onOpenOneStop,
  isSignedIn,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  onLoadConversation: (id: string) => void;
  onNewChat: () => void;
  onOpenOneStop: () => void;
  isSignedIn: boolean;
}) {
  return (
    <>
      <div className="p-3 space-y-1.5">
        <button
          onClick={onNewChat}
          className="w-full min-h-11 flex items-center gap-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-black/[0.045] dark:hover:bg-white/[0.07] py-2.5 px-3 rounded-xl transition-colors"
        >
          <Plus size={18} className="text-gray-500" /> New trip
        </button>
        <button
          onClick={onOpenOneStop}
          className="w-full min-h-11 flex items-center gap-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-black/[0.045] dark:hover:bg-white/[0.07] py-2.5 px-3 rounded-xl transition-colors"
        >
          <Bookmark size={18} className="text-gray-500" /> One Stop
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
        <div className="text-[13px] font-medium text-gray-400 dark:text-gray-500 px-3 pb-1">Recent</div>
        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => onLoadConversation(c.id)}
            className={`group flex items-center justify-between px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${
              activeConversationId === c.id ? 'bg-blue-600/10 text-blue-700 dark:text-blue-300 font-medium' : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.06] text-gray-600 dark:text-gray-300'
            }`}
          >
            <span className="truncate flex items-center min-w-0">
              {c.title || 'Trip'}
            </span>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this conversation?')) return;
                await fetch(`/api/chat/conversations/${c.id}`, { method: 'DELETE' });
                mutate('/api/chat/conversations');
              }}
              className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
              title="Delete conversation"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="p-3 border-t border-gray-100 dark:border-gray-800">
        {!isSignedIn ? (
          <SignInButtonWrapper mode="modal">
            <button className="w-full flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 py-2.5 px-3 rounded-lg transition-colors">
              <LogIn size={18} className="text-gray-500" /> Sign in
            </button>
          </SignInButtonWrapper>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1">
            <UserButtonWrapper afterSignOutUrl="/" />
            <span className="text-sm text-gray-500 dark:text-gray-400">Account</span>
          </div>
        )}
      </div>
    </>
  );
}

export default function ChatPage() {
  const { isSignedIn, isLoaded } = useUser();
  const [messages, setMessages] = useState<ChatMessageUI[]>([]);
  const [input, setInput] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [oneStopOpen, setOneStopOpen] = useState(false);
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [savedTrips, setSavedTrips] = useState<SavedTrip[]>([]);
  const [showSignInPrompt, setShowSignInPrompt] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Load saved trips — from API if signed in, from localStorage if guest.
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      // Fetch from server for signed-in users.
      fetch('/api/saved-trips')
        .then((r) => r.json())
        .then((data) => {
          if (data.trips) setSavedTrips(data.trips);
        })
        .catch(() => {
          // Fall back to localStorage if API fails.
          try {
            const raw = localStorage.getItem('trip-ai-onestop');
            if (raw) setSavedTrips(JSON.parse(raw));
          } catch { /* ignore */ }
        });
    } else {
      // Guest — load from localStorage.
      try {
        const raw = localStorage.getItem('trip-ai-onestop');
        if (raw) setSavedTrips(JSON.parse(raw));
      } catch { /* ignore */ }
    }
  }, [isLoaded, isSignedIn]);

  // Persist saved trips to localStorage (always, as a fallback for guests).
  useEffect(() => {
    if (!isLoaded || isSignedIn) return; // Only persist locally for guests.
    try {
      localStorage.setItem('trip-ai-onestop', JSON.stringify(savedTrips));
    } catch {
      // ignore
    }
  }, [savedTrips, isLoaded, isSignedIn]);

  const saveTrip = async (payload: ChatPayload, conversationId: string) => {
    const destination = payload.entities?.destination || 'Trip';
    const startDate = payload.entities?.startDate;
    const endDate = payload.entities?.endDate;
    const dates = startDate
      ? `${startDate}${endDate ? ` - ${endDate}` : ''}`
      : payload.entities?.datesGeneral || 'Dates TBD';

    if (isSignedIn) {
      // Save to server for signed-in users.
      try {
        const res = await fetch('/api/saved-trips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId, destination, dates, payload }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.trip) {
            setSavedTrips((prev) => [data.trip, ...prev]);
            setOneStopOpen(true);
            return;
          }
        }
      } catch {
        // Fall through to localStorage.
      }
    }

    // Guest or API failure — save to localStorage.
    const newTrip: SavedTrip = {
      id: crypto.randomUUID(),
      conversationId,
      destination,
      dates,
      payload,
      todos: [],
      notes: '',
      savedAt: new Date().toISOString(),
    };
    setSavedTrips((prev) => [newTrip, ...prev]);
    setOneStopOpen(true);
  };

  const shareTrip = async (conversationId: string): Promise<string | null> => {
    if (!conversationId) return null;
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.url || null;
    } catch {
      return null;
    }
  };

  const { data: conversationsData } = useSWR<{ conversations: Conversation[] }>(
    '/api/chat/conversations',
    fetcher
  );
  const conversations = conversationsData?.conversations || [];

  const scrollToTop = () => {
    if (messagesRef.current) messagesRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // When loading starts, scroll to top so the user reads from the start.
  useEffect(() => {
    if (isLoading) scrollToTop();
  }, [isLoading]);

  // When streaming finishes, scroll to top so the user sees the itinerary
  // from the beginning, not the end.
  useEffect(() => {
    if (!isLoading && messages.length > 0) scrollToTop();
  }, [isLoading]);

  const loadConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    setIsLoading(true);
    const res = await fetch(`/api/chat/history?conversationId=${id}`);
    const data = await res.json();
    if (data.messages) {
      setMessages(
        data.messages.map((m: any) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: m.content,
          payload: m.payload,
        }))
      );
    }
    setIsLoading(false);
  }, []);

  const startNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
  };

  const sendMessage = async (textOverride?: string) => {
    const raw = textOverride ?? input;
    if (!raw.trim() || isLoading) return;
    const userText = raw.trim();
    if (!textOverride) setInput('');

    // Show the sign-in prompt when a guest sends their first message.
    if (!isSignedIn) setShowSignInPrompt(true);

    const userMessage: ChatMessageUI = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
    };
    const assistantMessage: ChatMessageUI = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'Thinking...',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userText, conversationId: activeConversationId }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'status') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.isStreaming) {
                  const currentIndex = pipelineStatusIndex(last.status);
                  const nextIndex = pipelineStatusIndex(data.message);
                  if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < currentIndex) return prev;
                  return [...prev.slice(0, -1), { ...last, status: data.message }];
                }
                return prev;
              });
            } else if (data.type === 'preview') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, content: data.content, status: 'Adding maps, transport & images...' }];
                }
                return prev;
              });
            } else if (data.type === 'final_content') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, content: data.content, status: undefined }];
                }
                return prev;
              });
            } else if (data.type === 'content') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, content: last.content + data.chunk, status: undefined }];
                }
                return prev;
              });
            } else if (data.type === 'done') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, payload: data.payload, isStreaming: false, status: undefined },
                  ];
                }
                return prev;
              });
              if (!activeConversationId && data.conversationId) {
                setActiveConversationId(data.conversationId);
              }
            } else if (data.type === 'error') {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: data.message, isStreaming: false, status: undefined },
                  ];
                }
                return prev;
              });
            }
          } catch {
            // ignore malformed lines
          }
        }
      }

      mutate('/api/chat/conversations');
    } catch (error) {
      console.error(error);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: 'Sorry, something went wrong.', isStreaming: false, status: undefined }];
        }
        return prev;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const mergeSession = async () => {
    await fetch('/api/chat/merge-session', { method: 'POST' });
    mutate('/api/chat/conversations');
  };

  useEffect(() => {
    if (isSignedIn) {
      mergeSession();
      setShowSignInPrompt(false);
    }
  }, [isSignedIn]);

  return (
    <div className="flex h-[100dvh] bg-[#f5f5f7] dark:bg-black overflow-x-hidden font-sans text-[17px] leading-[22px]">
      {/* Desktop Sidebar */}
      <aside className="w-72 bg-white/80 dark:bg-[#1c1c1e]/90 backdrop-blur-xl backdrop-saturate-[1.8] border-r border-black/[0.05] dark:border-white/[0.1] flex-col hidden md:flex">
        <a href="/" className="h-16 px-5 flex items-center gap-2.5 border-b border-black/[0.05] dark:border-white/[0.1] hover:bg-black/[0.025] dark:hover:bg-white/[0.05] transition-colors">
          <WalkersIcon className="text-blue-600" size={24} />
          <span className="font-semibold tracking-tight text-xl text-gray-950 dark:text-white">Jalan</span>
        </a>
        <SidebarContent
          conversations={conversations}
          activeConversationId={activeConversationId}
          onLoadConversation={loadConversation}
          onNewChat={startNewChat}
          onOpenOneStop={() => setOneStopOpen(true)}
          isSignedIn={isSignedIn}
        />
      </aside>

      {/* Mobile sidebar drawer */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setSidebarOpen(false)} />
          <aside className="relative w-[min(20rem,86vw)] bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl backdrop-saturate-[1.8] border-r border-black/[0.05] dark:border-white/[0.1] flex-col flex h-full shadow-2xl">
            <div className="h-16 px-4 border-b border-black/[0.05] dark:border-white/[0.1] flex items-center justify-between">
              <a href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                <WalkersIcon className="text-blue-600" size={22} />
                <span className="font-bold text-lg">Jalan</span>
              </a>
              <button onClick={() => setSidebarOpen(false)} className="p-1 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
                <X size={20} />
              </button>
            </div>
            <SidebarContent
              conversations={conversations}
              activeConversationId={activeConversationId}
              onLoadConversation={(id) => { loadConversation(id); setSidebarOpen(false); }}
              onNewChat={() => { startNewChat(); setSidebarOpen(false); }}
              onOpenOneStop={() => { setOneStopOpen(true); setSidebarOpen(false); }}
              isSignedIn={isSignedIn}
            />
          </aside>
        </div>
      )}

      {/* Main chat */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <div className="md:hidden h-14 bg-white/80 dark:bg-[#1c1c1e]/85 backdrop-blur-xl backdrop-saturate-[1.8] border-b border-black/[0.05] dark:border-white/[0.1] px-3 flex items-center justify-between sticky top-0 z-30">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            title="Menu"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2">
            <a href="/" className="flex items-center gap-1.5 text-gray-700 dark:text-gray-200 font-semibold hover:opacity-80 transition-opacity">
              <WalkersIcon className="text-blue-600" size={18} />
              <span>Jalan</span>
            </a>
          </div>
          {!isSignedIn ? (
            <SignInButtonWrapper mode="modal">
              <button className="text-sm text-blue-600 dark:text-blue-400 font-medium px-3 py-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors">Sign in</button>
            </SignInButtonWrapper>
          ) : (
            <UserButtonWrapper afterSignOutUrl="/" />
          )}
        </div>

        {/* Desktop header — minimal, just account on the right */}
        <div className="hidden md:flex h-16 items-center justify-end gap-1 bg-white/70 dark:bg-[#1c1c1e]/80 backdrop-blur-xl backdrop-saturate-[1.8] border-b border-black/[0.05] dark:border-white/[0.1] px-6">
          <ThemeToggle />
          {!isSignedIn ? (
            <SignInButtonWrapper mode="modal">
              <button className="text-sm text-blue-600 dark:text-blue-400 font-medium px-3 py-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors">Sign in</button>
            </SignInButtonWrapper>
          ) : (
            <UserButtonWrapper afterSignOutUrl="/" />
          )}
        </div>

        {/* Messages + section navigator */}
        <div className="flex-1 flex overflow-hidden">
          <div ref={messagesRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-8 py-5 md:py-8 pb-44 space-y-7">
            {/* Closable sign-in prompt — appears when a guest sends a message */}
            {showSignInPrompt && !isSignedIn && (
              <div className="sticky top-0 z-20 -mx-4 md:-mx-6 -mt-4 md:-mt-6 mb-2 px-4 md:px-6 py-3 bg-gray-900 text-white flex items-center justify-between gap-3 shadow-md">
                <div className="flex items-center gap-2 min-w-0">
                  <LogIn size={18} className="flex-shrink-0" />
                  <span className="text-sm font-medium truncate">Sign in to save your trip and access it across devices.</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <SignInButtonWrapper mode="modal">
                    <button className="text-sm bg-white text-gray-900 font-semibold px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
                      Sign in
                    </button>
                  </SignInButtonWrapper>
                  <button
                    onClick={() => setShowSignInPrompt(false)}
                    className="text-white/70 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
                    aria-label="Dismiss"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            )}
            {messages.length === 0 ? (
              <div className="min-h-full flex flex-col items-center justify-center text-center px-2 py-10 max-w-3xl mx-auto">
                <div className="mb-6 w-16 h-16 rounded-2xl bg-white dark:bg-[#1c1c1e] shadow-[0_8px_30px_rgba(0,0,0,0.08)] flex items-center justify-center">
                  <WalkersIcon className="text-blue-600" size={34} />
                </div>
                <h1 className="text-4xl md:text-5xl font-semibold tracking-[-0.035em] text-gray-950 dark:text-white mb-4">Where to next?</h1>
                <p className="text-base md:text-lg leading-7 text-gray-500 dark:text-gray-400 max-w-xl mb-8">
                  Tell me where you want to go and when. I&apos;ll build a day-by-day itinerary with real weather, live flight deals, and transport routing.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mb-6">
                  {[
                    { label: '🗼 Tokyo in October', msg: 'Plan a 5-day trip to Tokyo in October' },
                    { label: '🏖️ Beach week in Bali', msg: 'Plan a relaxing beach trip to Bali for 7 days in November' },
                    { label: '🍜 Food trip to Bangkok', msg: 'Plan a 4-day food trip to Bangkok in December' },
                    { label: '⚽ Football in London', msg: 'Plan a 3-day football trip to London in October. I want to visit stadiums.' },
                    { label: '💍 Honeymoon in Santorini', msg: 'Plan a romantic 5-day honeymoon in Santorini in June' },
                    { label: '🎒 Budget Seoul weekend', msg: 'Plan a budget 3-day trip to Seoul in March' },
                  ].map((s) => (
                    <button
                      key={s.label}
                      onClick={() => { sendMessage(s.msg); }}
                      className="min-h-11 px-4 py-2.5 bg-white/90 dark:bg-[#1c1c1e] border border-black/[0.08] dark:border-white/[0.1] rounded-full text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-white hover:border-blue-500/40 hover:text-blue-600 hover:-translate-y-0.5 hover:shadow-md transition-all"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[13px] text-gray-400">
                  <span className="flex items-center gap-1">🌤️ Real weather</span>
                  <span className="flex items-center gap-1">✈️ Live flight deals</span>
                  <span className="flex items-center gap-1">🗺️ Transport routing</span>
                  <span className="flex items-center gap-1">🎒 Packing tips</span>
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`flex gap-3 max-w-5xl mx-auto ${m.role === 'user' ? 'justify-end' : 'justify-start'} message-fade-in`}>
                  {m.role === 'assistant' && (
                    <div className="flex-shrink-0 mt-1">
                      <WalkersIcon className="text-blue-600" size={26} />
                    </div>
                  )}
                  <div
                    className={`min-w-0 ${
                      m.role === 'user'
                        ? 'max-w-[min(42rem,88%)] bg-blue-600 text-white px-5 py-3 rounded-[1.35rem] rounded-br-md shadow-sm'
                        : 'max-w-4xl w-full text-gray-800 dark:text-gray-200'
                    }`}
                  >
                    <MessageContent
                      message={m}
                      onSaveTrip={m.role === 'assistant' ? (payload) => saveTrip(payload, activeConversationId || 'new') : undefined}
                      onShare={m.role === 'assistant' && activeConversationId ? async () => {
                        const url = await shareTrip(activeConversationId);
                        if (url) {
                          setShareUrls((prev) => ({ ...prev, [m.id]: url }));
                        }
                      } : undefined}
                      shareUrl={shareUrls[m.id]}
                      isSignedIn={isSignedIn}
                    />
                  </div>
                </div>
              ))
            )}
            {/* Tweak prompt — at the bottom of the chat, after all messages */}
            {messages.length > 0 && !isLoading && messages[messages.length - 1]?.role === 'assistant' && (
              <div className="max-w-3xl mx-auto text-center text-sm text-gray-400 dark:text-gray-500 italic py-4 border-t border-gray-100 dark:border-gray-800 mt-2">
                Want to tweak anything? Just say the word — shorter trip, different budget, business class, you name it.
              </div>
            )}
          </div>

          {/* Section navigator — right side mini tab (desktop) + floating button (mobile) */}
          {(() => {
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
            if (!lastAssistant || !lastAssistant.content) return null;

            // Markdown headings from the itinerary text
            const mdHeadings = extractHeadings(lastAssistant.content);

            // Payload sections (weather, transport, packing, deals, routes) rendered as UI cards
            const payload = lastAssistant.payload;
            const payloadHeadings: { id: string; label: string; level: number }[] = [];
            if (payload?.weather) payloadHeadings.push({ id: 'section-weather', label: 'Weather Outlook', level: 2 });
            if (payload?.transportPlan) payloadHeadings.push({ id: 'section-transport', label: 'Transport & Getting Around', level: 2 });
            if (payload?.packingTips) payloadHeadings.push({ id: 'section-packing', label: 'Packing Suggestions', level: 2 });
            if (payload?.deals?.length) payloadHeadings.push({ id: 'section-deals', label: 'Points Flight Deals', level: 2 });
            if (payload?.routeLinks?.length) payloadHeadings.push({ id: 'section-routes', label: 'Daily Routes', level: 2 });

            const headings = [...mdHeadings, ...payloadHeadings];
            if (headings.length < 2) return null;

            const jumpTo = (id: string) => {
              const el = document.getElementById(id);
              if (el && messagesRef.current) {
                // Calculate the scroll position manually so the element appears
                // below the sticky header, not hidden behind the input area.
                const container = messagesRef.current;
                const containerRect = container.getBoundingClientRect();
                const elRect = el.getBoundingClientRect();
                const offset = elRect.top - containerRect.top + container.scrollTop - 80;
                container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
              }
              setSectionsOpen(false);
            };

            const sectionButtons = headings.map((h) => {
              const isDay = h.id.startsWith('day-') || /^day\s+\d+/i.test(h.label);
              const dayNumber = h.label.match(/Day\s+(\d+)/i)?.[1] || '';
              const cleanLabel = isDay ? h.label.replace(/^Day\s+\d+\s*[:\-—]?\s*/i, '') : h.label;
              return (
                <button
                  key={h.id}
                  onClick={() => jumpTo(h.id)}
                  className="w-full text-left text-[13px] text-gray-500 dark:text-gray-400 hover:text-blue-600 py-1.5 px-2 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors truncate"
                  title={h.label}
                >
                  {isDay ? (
                    <span><span className="text-gray-400 dark:text-gray-600 mr-1.5">{dayNumber}.</span>{cleanLabel}</span>
                  ) : (
                    h.label
                  )}
                </button>
              );
            });

            return (
              <>
                {/* Desktop — section navigation rail */}
                <nav className="hidden lg:flex flex-col w-56 bg-white/40 dark:bg-[#1c1c1e]/40 border-l border-black/[0.05] dark:border-white/[0.1] py-5 px-3 h-full overflow-hidden">
                  <div className="overflow-y-auto flex-1 space-y-0.5">
                    {sectionButtons}
                  </div>
                </nav>

                {/* Mobile floating button */}
                <button
                  onClick={() => setSectionsOpen(true)}
                  className="lg:hidden fixed right-4 bottom-24 z-30 w-11 h-11 flex items-center justify-center bg-white/90 dark:bg-[#2c2c2e]/95 backdrop-blur-xl backdrop-saturate-[1.8] border border-black/[0.1] dark:border-white/[0.12] text-gray-700 dark:text-gray-200 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)] hover:bg-white dark:hover:bg-[#3a3a3c] active:scale-95 transition-all"
                  title="Jump to section"
                >
                  <List size={20} />
                </button>

                {/* Mobile drawer */}
                {sectionsOpen && (
                  <div className="lg:hidden fixed inset-0 z-50 flex items-end">
                    <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setSectionsOpen(false)} />
                    <nav className="relative w-full max-h-[72dvh] bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl backdrop-saturate-[1.8] border-t border-black/[0.05] dark:border-white/[0.1] shadow-[0_-12px_40px_rgba(0,0,0,0.16)] rounded-t-[24px] flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] message-fade-in">
                      <div className="pt-2.5 flex justify-center">
                        <div className="w-10 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
                      </div>
                      <div className="px-4 py-2 border-b border-black/[0.05] dark:border-white/[0.1] flex items-center justify-between">
                        <span className="text-[17px] font-semibold text-gray-900 dark:text-white">Jump to section</span>
                        <button onClick={() => setSectionsOpen(false)} className="w-11 h-11 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-full hover:bg-black/[0.05] dark:hover:bg-white/[0.08]" aria-label="Close sections">
                          <X size={18} />
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto p-3 space-y-1">
                        {sectionButtons}
                      </div>
                    </nav>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        <OneStopPanel
          isOpen={oneStopOpen}
          onClose={() => setOneStopOpen(false)}
          savedTrips={savedTrips}
          setSavedTrips={setSavedTrips}
          isSignedIn={isSignedIn}
        />

        {/* Input area */}
        <div className="bg-white/80 dark:bg-[#1c1c1e]/85 backdrop-blur-xl backdrop-saturate-[1.8] border-t border-black/[0.05] dark:border-white/[0.1] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-end gap-2 bg-white dark:bg-[#2c2c2e] border border-black/[0.1] dark:border-white/[0.12] rounded-[1.35rem] shadow-[0_8px_30px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.08)] focus-within:border-blue-500/50 focus-within:ring-4 focus-within:ring-blue-500/10 transition-all px-1.5 py-1.5">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Where do you want to go?"
                rows={1}
                className="flex-1 resize-none max-h-32 bg-transparent px-3 py-3 focus:outline-none text-[16px] leading-6 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"
                disabled={isLoading}
              />
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || isLoading}
                className="w-11 h-11 self-center bg-blue-600 text-white rounded-full hover:bg-blue-700 active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed transition-all flex-shrink-0 flex items-center justify-center shadow-sm"
                title="Send"
                aria-label="Send message"
              >
                <span key={isLoading ? 'loading' : 'send'} className="message-fade-in">
                  {isLoading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                </span>
              </button>
            </div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500 text-center mt-1.5">
              Press Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
