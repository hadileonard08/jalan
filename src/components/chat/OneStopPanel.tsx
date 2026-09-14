'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  X, Plus, Trash2, CheckSquare, Square, Plane, Clipboard, StickyNote,
  MapPin, Calendar, Map, Bell, ThumbsUp, ThumbsDown, MessageSquare,
  FileText, Upload, Download, Hotel, Train, Car, ChevronDown, ChevronUp,
  AlertTriangle, Sparkles, UserCog, UserPlus, Link2, Check, LogOut,
  List, Sun, Briefcase, Crown, Navigation,
} from 'lucide-react';
import { useUser } from '@/components/AuthProvider';
import type {
  SavedTrip, ChatPayload, StopFeedback, StopComment, DayFeedback, DayComment,
  ManualFlightEntry, UploadedDocument, WeatherSnapshot, TripProposal, NoteEntry, RouteLink,
  ItineraryPatch,
} from '@/lib/chat-state';
import { stripFollowUpQuestions } from '@/lib/itinerary-cleanup';
import { findEveningClosedVenues } from '@/lib/itinerary-feasibility';
import type { DayTransport } from '@/agents/transport';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const DailyRouteMap = dynamic(() => import('./DailyRouteMap'), {
  ssr: false,
  loading: () => <div className="w-full h-96 rounded-2xl bg-gray-100 dark:bg-[#2c2c2e] animate-pulse" />,
});

interface OneStopPanelProps {
  isOpen: boolean;
  onClose: () => void;
  savedTrips: SavedTrip[];
  setSavedTrips: React.Dispatch<React.SetStateAction<SavedTrip[]>>;
  isSignedIn: boolean;
}

function formatDate(iso?: string | Date) {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Extract landmark names from the itinerary markdown so we can attach
// per-stop feedback. We look for bold text and IMAGE placeholders per day.
function extractStopsFromItinerary(itinerary: string): { day: string; stops: { name: string; id: string }[] }[] {
  if (!itinerary) return [];
  const dayBlocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
  const result: { day: string; stops: { name: string; id: string }[] }[] = [];
  const GENERIC = new Set([
    'morning', 'afternoon', 'evening', 'night', 'lunch', 'dinner', 'breakfast',
    'getting around', 'transport', 'tips', 'overview', 'summary',
  ]);
  const TRANSIT = /\b(line|subway|metro|train|railway|station|airport|bus|taxi|walk|transfer|fare|ticket|pass|express|monorail|tram|ferry)\b/i;

  for (const block of dayBlocks) {
    const headingMatch = block.match(/#+\s+Day\s+(\d+)/i);
    if (!headingMatch) continue;
    const day = headingMatch[1];
    const stops: { name: string; id: string }[] = [];
    const seen = new Set<string>();

    // Image placeholders are explicit landmarks.
    for (const m of block.matchAll(/!\[IMAGE:\s*([^\]]+)\]/g)) {
      const name = m[1].trim();
      const id = name.toLowerCase();
      if (!seen.has(id)) { seen.add(id); stops.push({ name, id }); }
    }
    // Bold text.
    for (const m of block.matchAll(/\*\*(.*?)\*\*/g)) {
      const name = m[1].trim();
      if (name.length < 3) continue;
      if (GENERIC.has(name.toLowerCase())) continue;
      if (TRANSIT.test(name)) continue;
      if (/^(morning|afternoon|evening)/i.test(name)) continue;
      const id = name.toLowerCase();
      if (!seen.has(id)) { seen.add(id); stops.push({ name, id }); }
    }
    if (stops.length > 0) result.push({ day, stops });
  }
  return result;
}

// Grows with what you type instead of scrolling a one-line box, so a longer
// comment or suggestion stays readable. Enter sends, Shift+Enter adds a line.
function AutoGrowTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  ariaLabel,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first, otherwise the box can only ever grow.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    // Only show a scrollbar once the box is capped by max-height. Leaving it on
    // `auto` draws a track even when everything fits.
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      className="flex-1 min-w-0 text-[15px] leading-6 border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 disabled:opacity-60 resize-none max-h-40 overflow-hidden"
    />
  );
}

// --- Stop feedback (thumbs up/down + comments) ---

function getStopFeedback(trip: SavedTrip, stopId: string): StopFeedback {
  return trip.feedback?.[stopId] || {
    stopId,
    thumbsUp: 0,
    thumbsDown: 0,
    userVote: null,
    comments: [],
  };
}

function StopFeedbackBar({
  stopId,
  stopName,
  trip,
  onUpdate,
}: {
  stopId: string;
  stopName: string;
  trip: SavedTrip;
  onUpdate: (trip: SavedTrip) => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const fb = getStopFeedback(trip, stopId);

  const vote = (direction: 'up' | 'down') => {
    const current = getStopFeedback(trip, stopId);
    const newFeedback: Record<string, StopFeedback> = { ...trip.feedback };
    let thumbsUp = current.thumbsUp;
    let thumbsDown = current.thumbsDown;
    let userVote: 'up' | 'down' | null = direction;

    // Toggle off if clicking the same vote.
    if (current.userVote === direction) {
      userVote = null;
      if (direction === 'up') thumbsUp = Math.max(0, thumbsUp - 1);
      else thumbsDown = Math.max(0, thumbsDown - 1);
    } else {
      // Switching vote: decrement old, increment new.
      if (current.userVote === 'up') thumbsUp = Math.max(0, thumbsUp - 1);
      if (current.userVote === 'down') thumbsDown = Math.max(0, thumbsDown - 1);
      if (direction === 'up') thumbsUp += 1;
      else thumbsDown += 1;
    }

    newFeedback[stopId] = { ...current, thumbsUp, thumbsDown, userVote };
    onUpdate({ ...trip, feedback: newFeedback });
  };

  const addComment = () => {
    if (!commentText.trim()) return;
    const current = getStopFeedback(trip, stopId);
    const newComment: StopComment = {
      id: crypto.randomUUID(),
      author: 'You',
      text: commentText.trim(),
      createdAt: new Date().toISOString(),
    };
    const newFeedback: Record<string, StopFeedback> = { ...trip.feedback };
    newFeedback[stopId] = { ...current, comments: [...current.comments, newComment] };
    onUpdate({ ...trip, feedback: newFeedback });
    setCommentText('');
  };

  const deleteComment = (commentId: string) => {
    const current = getStopFeedback(trip, stopId);
    const newFeedback: Record<string, StopFeedback> = { ...trip.feedback };
    newFeedback[stopId] = {
      ...current,
      comments: current.comments.filter((c) => c.id !== commentId),
    };
    onUpdate({ ...trip, feedback: newFeedback });
  };

  return (
    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
      <div className="flex items-center gap-3">
        <button
          onClick={() => vote('up')}
          className={`flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg transition-colors ${
            fb.userVote === 'up'
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          title="Thumbs up"
        >
          <ThumbsUp size={14} />
          {fb.thumbsUp > 0 && <span>{fb.thumbsUp}</span>}
        </button>
        <button
          onClick={() => vote('down')}
          className={`flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg transition-colors ${
            fb.userVote === 'down'
              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          title="Thumbs down"
        >
          <ThumbsDown size={14} />
          {fb.thumbsDown > 0 && <span>{fb.thumbsDown}</span>}
        </button>
        <button
          onClick={() => setShowComments(!showComments)}
          className="flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Comments"
        >
          <MessageSquare size={14} />
          {fb.comments.length > 0 && <span>{fb.comments.length}</span>}
          <span className="hidden sm:inline">Comment</span>
        </button>
      </div>

      {showComments && (
        <div className="mt-2 space-y-2">
          {fb.comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2 group">
              <div className="flex-1 min-w-0 text-[13px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words">
                <span className="font-medium text-gray-700 dark:text-gray-300">{c.author}: </span>
                {c.text}
                <span className="text-gray-400 dark:text-gray-600 ml-1">· {formatDateTime(c.createdAt)}</span>
              </div>
              <button
                onClick={() => deleteComment(c.id)}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addComment()}
              placeholder="Add a note (e.g. 'Skip this, too touristy')..."
              className="flex-1 min-w-0 text-[13px] border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={addComment}
              disabled={!commentText.trim()}
              className="flex-shrink-0 px-3 py-1.5 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Split the itinerary into blocks, each beginning with a Day heading.
function splitItineraryByDay(itinerary: string): { day?: number; content: string }[] {
  if (!itinerary) return [];
  const blocks = itinerary.split(/(?=#+\s+Day\s+\d+)/i).filter(Boolean);
  return blocks.map((block) => {
    const headingMatch = block.match(/#+\s+Day\s+(\d+)/i);
    return { day: headingMatch ? Number(headingMatch[1]) : undefined, content: block };
  });
}

// --- Per-day feedback (thumbs up/down + comments) ---

function getDayFeedback(trip: SavedTrip, dayIndex: number): DayFeedback {
  return trip.dayFeedback?.[String(dayIndex)] || {
    dayIndex,
    thumbsUp: 0,
    thumbsDown: 0,
    userVote: null,
    comments: [],
  };
}

function DayFeedbackBar({
  dayIndex,
  trip,
  onUpdate,
}: {
  dayIndex: number;
  trip: SavedTrip;
  onUpdate: (trip: SavedTrip) => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const fb = getDayFeedback(trip, dayIndex);

  const vote = (direction: 'up' | 'down') => {
    const current = getDayFeedback(trip, dayIndex);
    const newFeedback: Record<string, DayFeedback> = { ...(trip.dayFeedback || {}) };
    let thumbsUp = current.thumbsUp;
    let thumbsDown = current.thumbsDown;
    let userVote: 'up' | 'down' | null = direction;

    if (current.userVote === direction) {
      userVote = null;
      if (direction === 'up') thumbsUp = Math.max(0, thumbsUp - 1);
      else thumbsDown = Math.max(0, thumbsDown - 1);
    } else {
      if (current.userVote === 'up') thumbsUp = Math.max(0, thumbsUp - 1);
      if (current.userVote === 'down') thumbsDown = Math.max(0, thumbsDown - 1);
      if (direction === 'up') thumbsUp += 1;
      else thumbsDown += 1;
    }

    newFeedback[String(dayIndex)] = { ...current, thumbsUp, thumbsDown, userVote };
    onUpdate({ ...trip, dayFeedback: newFeedback });
  };

  const addComment = () => {
    if (!commentText.trim()) return;
    const current = getDayFeedback(trip, dayIndex);
    const newComment: DayComment = {
      id: crypto.randomUUID(),
      author: 'You',
      text: commentText.trim(),
      createdAt: new Date().toISOString(),
    };
    const newFeedback: Record<string, DayFeedback> = { ...(trip.dayFeedback || {}) };
    newFeedback[String(dayIndex)] = { ...current, comments: [...current.comments, newComment] };
    onUpdate({ ...trip, dayFeedback: newFeedback });
    setCommentText('');
  };

  const deleteComment = (commentId: string) => {
    const current = getDayFeedback(trip, dayIndex);
    const newFeedback: Record<string, DayFeedback> = { ...(trip.dayFeedback || {}) };
    newFeedback[String(dayIndex)] = {
      ...current,
      comments: current.comments.filter((c) => c.id !== commentId),
    };
    onUpdate({ ...trip, dayFeedback: newFeedback });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 pb-3 border-b border-gray-100 dark:border-gray-700/50">
        <button
          onClick={() => vote('up')}
          className={`flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg transition-colors ${
            fb.userVote === 'up'
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          title="Thumbs up"
        >
          <ThumbsUp size={16} />
          {fb.thumbsUp > 0 && <span>{fb.thumbsUp}</span>}
        </button>
        <button
          onClick={() => vote('down')}
          className={`flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg transition-colors ${
            fb.userVote === 'down'
              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          title="Thumbs down"
        >
          <ThumbsDown size={16} />
          {fb.thumbsDown > 0 && <span>{fb.thumbsDown}</span>}
        </button>
        <button
          onClick={() => setShowComments(!showComments)}
          className="md:hidden flex items-center gap-1 text-[13px] px-2 py-1 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Comments"
        >
          <MessageSquare size={14} />
          {showComments ? 'Hide' : `View ${fb.comments.length}`}
        </button>
      </div>

      <div className={`flex-1 min-h-0 ${showComments ? 'block' : 'hidden md:block'}`}>
        <div className="max-h-80 overflow-y-auto py-2 space-y-2">
          {fb.comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2 group">
              <div className="flex-1 min-w-0 text-[13px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words">
                <span className="font-medium text-gray-700 dark:text-gray-300">{c.author}: </span>
                {c.text}
                <span className="text-gray-400 dark:text-gray-600 ml-1">· {formatDateTime(c.createdAt)}</span>
              </div>
              <button
                onClick={() => deleteComment(c.id)}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={`pt-2 border-t border-gray-100 dark:border-gray-700/50 ${showComments ? 'block' : 'hidden md:block'}`}>
        <div className="flex items-end gap-2">
          <AutoGrowTextarea
            value={commentText}
            onChange={setCommentText}
            onSubmit={addComment}
            placeholder="Add a comment..."
            ariaLabel={`Add a comment for Day ${dayIndex}`}
          />
          <button
            onClick={addComment}
            disabled={!commentText.trim()}
            className="flex-shrink-0 px-3.5 py-2 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Per-day collaboration column ---
// Desktop shows it inline next to the day; mobile collapses it behind a summary
// row so a long itinerary stays readable on a small screen.

function DayPanel({
  day,
  trip,
  onUpdate,
  proposalRole,
  proposals,
  submittingDay,
  onSubmitProposal,
  onPreviewProposal,
  onSendApprovedProposal,
  onReviewProposal,
  onEditProposal,
  onWithdrawProposal,
  proposalActionId,
  userId,
}: {
  day: number;
  trip: SavedTrip;
  onUpdate: (trip: SavedTrip) => void;
  proposalRole: TripRole | null;
  proposals: TripProposal[];
  submittingDay: number | null;
  onSubmitProposal: (day: number, prompt: string, patch?: ItineraryPatch) => Promise<boolean>;
  onPreviewProposal: (day: number, prompt: string) => Promise<PatchPreview | null>;
  onSendApprovedProposal: (day: number, prompt: string, patch: ItineraryPatch) => Promise<boolean>;
  onReviewProposal: (proposalId: string, action: 'accept' | 'reject') => void;
  onEditProposal: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdrawProposal: (proposalId: string) => void;
  proposalActionId: string | null;
  userId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fb = getDayFeedback(trip, day);
  const pendingCount = proposals.filter((p) => p.status === 'pending').length;
  // Venues that close in the late afternoon but sit in the Evening block.
  const feasibility = findEveningClosedVenues(trip.payload.itinerary || '').filter(
    (issue) => issue.day === day,
  );

  return (
    <div className="md:col-span-1 md:sticky md:top-4 md:self-start rounded-xl border border-gray-100 dark:border-gray-700/50 p-3 bg-gray-50/50 dark:bg-gray-800/30">
      <div className="hidden md:block text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Day {day}
      </div>

      {/* Mobile summary + toggle */}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="md:hidden w-full min-h-[44px] flex items-center justify-between gap-2 text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2.5 text-[13px] text-gray-500 dark:text-gray-400">
          <span className="font-semibold uppercase tracking-wide">Day {day}</span>
          <span className="flex items-center gap-1">
            <ThumbsUp size={13} /> {fb.thumbsUp}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare size={13} /> {fb.comments.length}
          </span>
          {pendingCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <UserCog size={13} /> {pendingCount}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 text-[12px] font-medium text-blue-600 dark:text-blue-400 flex-shrink-0">
          {expanded ? 'Hide' : 'Collaborate'}
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </span>
      </button>

      <div className={`${expanded ? 'block' : 'hidden'} md:block mt-2 md:mt-0`}>
        {feasibility.length > 0 && (
          <div className="mb-3 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/40 rounded-lg px-2 py-1.5">
            <span className="font-medium">Check the hours:</span>{' '}
            {feasibility.map((i) => i.name).join(', ')} usually closes in the late afternoon, but it
            is in the Evening block.
          </div>
        )}
        <DayFeedbackBar dayIndex={day} trip={trip} onUpdate={onUpdate} />
        <DayProposalBox
          day={day}
          role={proposalRole}
          proposals={proposals}
          submitting={submittingDay === day}
          onSubmit={onSubmitProposal}
          onPreview={onPreviewProposal}
          onSendApproved={onSendApprovedProposal}
          onReview={onReviewProposal}
          onEdit={onEditProposal}
          onWithdraw={onWithdrawProposal}
          actionId={proposalActionId}
          userId={userId}
        />
      </div>
    </div>
  );
}

// --- Itinerary tab with per-day feedback ---

function ItineraryTab({
  trip,
  onUpdate,
  proposalRole,
  proposals,
  submittingDay,
  onSubmitProposal,
  onPreviewProposal,
  onSendApprovedProposal,
  onReviewProposal,
  onEditProposal,
  onWithdrawProposal,
  proposalActionId,
  userId,
}: {
  trip: SavedTrip;
  onUpdate: (trip: SavedTrip) => void;
  proposalRole: TripRole | null;
  proposals: TripProposal[];
  submittingDay: number | null;
  onSubmitProposal: (day: number, prompt: string, patch?: ItineraryPatch) => Promise<boolean>;
  onPreviewProposal: (day: number, prompt: string) => Promise<PatchPreview | null>;
  onSendApprovedProposal: (day: number, prompt: string, patch: ItineraryPatch) => Promise<boolean>;
  onReviewProposal: (proposalId: string, action: 'accept' | 'reject') => void;
  onEditProposal: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdrawProposal: (proposalId: string) => void;
  proposalActionId: string | null;
  userId?: string;
}) {
  const payload = trip.payload;
  // Saved plans shouldn't include the assistant's closing follow-up questions.
  const dayBlocks = splitItineraryByDay(stripFollowUpQuestions(payload.itinerary || ''));
  const itineraryDays = new Set(
    dayBlocks.map((block) => block.day).filter((day): day is number => day !== undefined)
  );
  // Suggestions that don't map to a day still in the itinerary (e.g. vague
  // requests that produced no edits) are listed at the end instead.
  const unassignedProposals = proposals.filter((proposal) => {
    const days = proposalDays(proposal);
    return days.length === 0 || days.every((day) => !itineraryDays.has(day));
  });

  const markdownComponents = {
    img: ({ src, alt }: any) => (
      <figure className="my-3">
        {src && <img src={src} alt={alt || ''} className="rounded-xl shadow-md w-full" loading="lazy" />}
        {alt && <figcaption className="text-[13px] text-gray-400 dark:text-gray-500 text-center mt-1">{alt}</figcaption>}
      </figure>
    ),
    h1: ({ children }: any) => <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 mt-2 mb-1">{children}</h1>,
    h2: ({ children }: any) => <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mt-3 mb-1">{children}</h2>,
    h3: ({ children }: any) => <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-2 mb-1">{children}</h3>,
    strong: ({ children }: any) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
    ul: ({ children }: any) => <ul className="list-disc list-inside my-2 space-y-0.5">{children}</ul>,
    ol: ({ children }: any) => <ol className="list-decimal list-inside my-2 space-y-0.5">{children}</ol>,
  };

  return (
    <div className="space-y-6">
      {dayBlocks.map(({ day, content }, index) =>
        day === undefined ? (
          <div key={`intro-${index}`} className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
          </div>
        ) : (
          <div
            key={day}
            className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 border-b border-gray-200 dark:border-gray-700/50 pb-6 last:border-0"
          >
            <div className="md:col-span-2 prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
            </div>
            <DayPanel
              day={day}
              trip={trip}
              onUpdate={onUpdate}
              proposalRole={proposalRole}
              proposals={proposals.filter((proposal) => proposalDays(proposal).includes(day))}
              submittingDay={submittingDay}
              onSubmitProposal={onSubmitProposal}
              onPreviewProposal={onPreviewProposal}
              onSendApprovedProposal={onSendApprovedProposal}
              onReviewProposal={onReviewProposal}
              onEditProposal={onEditProposal}
              onWithdrawProposal={onWithdrawProposal}
              proposalActionId={proposalActionId}
              userId={userId}
            />
          </div>
        )
      )}

      <UnassignedProposals
        role={proposalRole}
        proposals={unassignedProposals}
        onReview={onReviewProposal}
        onEdit={onEditProposal}
        onWithdraw={onWithdrawProposal}
        actionId={proposalActionId}
        userId={userId}
      />
    </div>
  );
}

// --- Flights & Docs tab ---

const MAX_PDF_BYTES = 10 * 1024 * 1024;

function validatePdf(file: File): string | null {
  if (file.size > MAX_PDF_BYTES) return 'File too large. Maximum size is 10 MB.';
  if (file.type !== 'application/pdf') return 'Only PDF files are supported.';
  return null;
}

function readDocument(file: File): Promise<UploadedDocument> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type,
      size: file.size,
      dataUrl: reader.result as string,
      uploadedAt: new Date().toISOString(),
    });
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

const ENTRY_TYPE_ICONS: Record<ManualFlightEntry['type'], typeof Plane> = {
  flight: Plane,
  hotel: Hotel,
  train: Train,
  car: Car,
  other: FileText,
};

function FlightsDocsTab({ trip, onUpdate }: { trip: SavedTrip; onUpdate: (trip: SavedTrip) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    type: 'flight' as ManualFlightEntry['type'],
    label: '',
    airlineOrProvider: '',
    confirmationCode: '',
    departureTime: '',
    arrivalTime: '',
    notes: '',
  });
  const [formDoc, setFormDoc] = useState<UploadedDocument | null>(null);
  const [formError, setFormError] = useState('');
  const formFileRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const entries = trip.flightInfo || [];
  const docs = trip.documents || [];
  // PDFs already linked to a booking are shown inside that booking.
  const attachedIds = new Set(entries.flatMap((entry) => entry.documentIds || []));
  const looseDocs = docs.filter((doc) => !attachedIds.has(doc.id));

  const resetForm = () => {
    setForm({
      type: 'flight', label: '', airlineOrProvider: '', confirmationCode: '',
      departureTime: '', arrivalTime: '', notes: '',
    });
    setFormDoc(null);
    setFormError('');
    if (formFileRef.current) formFileRef.current.value = '';
  };

  const attachFormFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const error = validatePdf(file);
    if (error) {
      setFormError(error);
      if (formFileRef.current) formFileRef.current.value = '';
      return;
    }
    try {
      setFormDoc(await readDocument(file));
      setFormError('');
    } catch {
      setFormError('Failed to read file.');
    }
  };

  const addEntry = () => {
    if (!form.label.trim() && !form.airlineOrProvider.trim()) return;
    const entry: ManualFlightEntry = {
      id: crypto.randomUUID(),
      type: form.type,
      label: form.label.trim() || form.airlineOrProvider.trim(),
      airlineOrProvider: form.airlineOrProvider.trim(),
      confirmationCode: form.confirmationCode.trim(),
      departureTime: form.departureTime || undefined,
      arrivalTime: form.arrivalTime || undefined,
      notes: form.notes.trim() || undefined,
      documentIds: formDoc ? [formDoc.id] : [],
      createdAt: new Date().toISOString(),
    };
    onUpdate({
      ...trip,
      flightInfo: [...entries, entry],
      documents: formDoc ? [...docs, formDoc] : docs,
    });
    resetForm();
    setShowForm(false);
  };

  const deleteEntry = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    const removedIds = new Set(entry?.documentIds || []);
    onUpdate({
      ...trip,
      flightInfo: entries.filter((e) => e.id !== id),
      documents: docs.filter((doc) => !removedIds.has(doc.id)),
    });
  };

  // Remove a PDF and unlink it from the booking it was attached to.
  const deleteDoc = (id: string) => {
    onUpdate({
      ...trip,
      flightInfo: entries.map((entry) => (
        entry.documentIds?.includes(id)
          ? { ...entry, documentIds: entry.documentIds.filter((docId) => docId !== id) }
          : entry
      )),
      documents: docs.filter((doc) => doc.id !== id),
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const error = validatePdf(file);
    if (error) {
      alert(error);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const doc = await readDocument(file);
      onUpdate({ ...trip, documents: [...docs, doc] });
    } catch {
      alert('Upload failed.');
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadDoc = (doc: UploadedDocument) => {
    const a = document.createElement('a');
    a.href = doc.dataUrl;
    a.download = doc.name;
    a.click();
  };

  return (
    <div className="space-y-4">
      {/* Manual entry form */}
      {showForm ? (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-gray-50 dark:bg-gray-800/50 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Booking</h3>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1"
            >
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ManualFlightEntry['type'] })}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              >
                <option value="flight">Flight</option>
                <option value="hotel">Hotel</option>
                <option value="train">Train</option>
                <option value="car">Car</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Label</label>
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Outbound Flight"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">
                {form.type === 'flight' ? 'Airline' : form.type === 'hotel' ? 'Hotel' : 'Provider'}
              </label>
              <input
                type="text"
                value={form.airlineOrProvider}
                onChange={(e) => setForm({ ...form, airlineOrProvider: e.target.value })}
                placeholder={form.type === 'flight' ? 'JAL' : form.type === 'hotel' ? 'Marriott' : 'Provider'}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Confirmation / PNR</label>
              <input
                type="text"
                value={form.confirmationCode}
                onChange={(e) => setForm({ ...form, confirmationCode: e.target.value })}
                placeholder="ABC123"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Departure</label>
              <input
                type="datetime-local"
                value={form.departureTime}
                onChange={(e) => setForm({ ...form, departureTime: e.target.value })}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Arrival</label>
              <input
                type="datetime-local"
                value={form.arrivalTime}
                onChange={(e) => setForm({ ...form, arrivalTime: e.target.value })}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div>
            <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Notes</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Seat 14A, gate B12..."
              className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">
              Ticket / voucher (PDF, optional)
            </label>
            <input
              ref={formFileRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={attachFormFile}
              className="hidden"
            />
            {formDoc ? (
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2">
                <FileText size={16} className="text-red-500 flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate text-[13px] text-gray-700 dark:text-gray-300">{formDoc.name}</span>
                <span className="text-[12px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                  {(formDoc.size / 1024).toFixed(0)} KB
                </span>
                <button
                  onClick={() => { setFormDoc(null); if (formFileRef.current) formFileRef.current.value = ''; }}
                  className="text-gray-400 hover:text-red-600 p-1 flex-shrink-0"
                  title="Remove attachment"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => formFileRef.current?.click()}
                className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg py-2 text-[13px] text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
              >
                <Upload size={14} /> Attach PDF
              </button>
            )}
            {formError && <div className="text-[12px] text-red-600 dark:text-red-400 mt-1">{formError}</div>}
          </div>
          <button
            onClick={addEntry}
            className="w-full bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-1.5"
          >
            <Plus size={16} /> Add Booking
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-3 text-sm text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus size={16} /> Add Flight / Hotel / Booking
        </button>
      )}

      {/* Booking entries */}
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => {
            const Icon = ENTRY_TYPE_ICONS[entry.type] || FileText;
            const attached = docs.filter((doc) => entry.documentIds?.includes(doc.id));
            return (
              <div key={entry.id} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-white dark:bg-gray-800 group">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <div className="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 p-2 rounded-lg flex-shrink-0">
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{entry.label}</div>
                      {entry.airlineOrProvider && (
                        <div className="text-[13px] text-gray-500 dark:text-gray-400">{entry.airlineOrProvider}</div>
                      )}
                      {entry.confirmationCode && (
                        <div className="text-[13px] text-gray-500 dark:text-gray-400">
                          Ref: <span className="font-mono">{entry.confirmationCode}</span>
                        </div>
                      )}
                      {entry.departureTime && (
                        <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">
                          Dep: {formatDateTime(entry.departureTime)}
                        </div>
                      )}
                      {entry.arrivalTime && (
                        <div className="text-[13px] text-gray-500 dark:text-gray-400">
                          Arr: {formatDateTime(entry.arrivalTime)}
                        </div>
                      )}
                      {entry.notes && (
                        <div className="text-[13px] text-gray-400 dark:text-gray-500 mt-1">{entry.notes}</div>
                      )}
                      {attached.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {attached.map((doc) => (
                            <div
                              key={doc.id}
                              className="flex items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 px-2.5 py-1.5"
                            >
                              <FileText size={14} className="text-red-500 flex-shrink-0" />
                              <span className="flex-1 min-w-0 truncate text-[13px] text-gray-700 dark:text-gray-300">{doc.name}</span>
                              <span className="text-[12px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                                {(doc.size / 1024).toFixed(0)} KB
                              </span>
                              <button
                                onClick={() => downloadDoc(doc)}
                                className="text-gray-400 hover:text-blue-600 p-1 flex-shrink-0"
                                title="Download"
                              >
                                <Download size={14} />
                              </button>
                              <button
                                onClick={() => deleteDoc(doc.id)}
                                className="text-gray-400 hover:text-red-600 p-1 flex-shrink-0"
                                title="Remove attachment"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteEntry(entry.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Standalone document upload */}
      <div className="border-t border-gray-100 dark:border-gray-700 pt-4 space-y-3">
        <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Other documents
        </div>
        <p className="text-[12px] text-gray-400 dark:text-gray-500 -mt-1">
          PDFs that aren&apos;t attached to a booking. Attach a ticket or voucher while adding a booking to keep them together.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-3 text-sm text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          {uploading ? (
            <><span className="animate-spin">⟳</span> Uploading...</>
          ) : (
            <><Upload size={16} /> Upload PDF (e-ticket, voucher — max 10 MB)</>
          )}
        </button>

        {looseDocs.length > 0 && (
          <div className="space-y-2">
            {looseDocs.map((doc) => (
              <div key={doc.id} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-white dark:bg-gray-800 group flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 p-2 rounded-lg flex-shrink-0">
                    <FileText size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{doc.name}</div>
                    <div className="text-[13px] text-gray-400 dark:text-gray-500">
                      {(doc.size / 1024).toFixed(0)} KB · {formatDate(doc.uploadedAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => downloadDoc(doc)}
                    className="text-gray-400 hover:text-blue-600 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    title="Download"
                  >
                    <Download size={16} />
                  </button>
                  <button
                    onClick={() => deleteDoc(doc.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Weather tab ---

function weatherEmoji(code: number | null): string {
  if (code == null) return '🌡️';
  if (code === 0) return '☀️';
  if ([1, 2].includes(code)) return '🌤️';
  if (code === 3) return '☁️';
  if ([45, 48].includes(code)) return '🌫️';
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '🌧️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return 'recently';
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return 'recently';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function WeatherTab({ trip }: { trip: SavedTrip }) {
  const snapshot: WeatherSnapshot | null | undefined = trip.weatherSnapshot;
  const planningWeather = typeof trip.payload.weather === 'string' ? trip.payload.weather : '';
  const startDate = trip.payload.entities?.startDate;
  const endDate = trip.payload.entities?.endDate || startDate;

  if (!snapshot || snapshot.days.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 text-[13px] text-gray-500 dark:text-gray-400">
          Live weather for {trip.destination} refreshes automatically once a day.
          {planningWeather ? ' Meanwhile, here is the forecast from when this trip was planned.' : ' Check back shortly.'}
        </div>
        {planningWeather && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{planningWeather}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  const tripDays = startDate
    ? snapshot.days.filter((day) => day.date >= startDate && day.date <= (endDate || startDate))
    : [];
  const displayDays = tripDays.length > 0 ? tripDays : snapshot.days.slice(0, 7);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          {tripDays.length > 0 ? 'Forecast for your trip' : 'Current outlook'}
        </div>
        <div className="text-[12px] text-gray-400 dark:text-gray-500">
          {trip.destination} · updated {formatRelativeTime(trip.weatherUpdatedAt || snapshot.updatedAt)}
        </div>
      </div>

      {tripDays.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 text-[13px] text-gray-500 dark:text-gray-400">
          Your trip is outside the 16-day forecast window. Showing the current 7-day outlook for {trip.destination}.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {displayDays.map((day) => (
          <div key={day.date} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
            <div className="text-[12px] font-medium text-gray-500 dark:text-gray-400">{formatDayLabel(day.date)}</div>
            <div className="text-2xl leading-tight mt-1">{weatherEmoji(day.code)}</div>
            <div className="text-[13px] text-gray-700 dark:text-gray-300 mt-1">{day.condition}</div>
            <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">
              {day.maxTemp != null ? `${Math.round(day.maxTemp)}°` : '–'}
              {' / '}
              {day.minTemp != null ? `${Math.round(day.minTemp)}°` : '–'}
            </div>
            {day.precipitationProbability != null && (
              <div className="text-[12px] text-blue-600 dark:text-blue-400 mt-0.5">💧 {day.precipitationProbability}%</div>
            )}
          </div>
        ))}
      </div>

      <div className="text-[12px] text-gray-400 dark:text-gray-500">
        Refreshed daily by the Jalan weather check.
      </div>
    </div>
  );
}

// --- Proposals (multiplayer AI collaboration) ---

// Two roles: the trip's creator is the Master Planner, everyone invited is a
// Follower. Followers suggest and comment; only the Master Planner approves.
type TripRole = 'owner' | 'collaborator';

// A drafted-but-unsent suggestion, shown to the suggester for confirmation.
interface PatchPreview {
  prompt: string;
  dayIndex: number | null;
  patch: ItineraryPatch;
  wouldChange: boolean;
  findings?: { feedback: string[]; advisory: string[] };
}

const ROLE_LABELS: Record<TripRole, string> = {
  owner: 'Master Planner',
  collaborator: 'Follower',
};

const ROLE_BADGE_STYLES: Record<TripRole, string> = {
  owner: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  collaborator: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
};

const ROLE_TOOLTIPS: Record<TripRole, string> = {
  owner: 'You are the Master Planner: you can suggest, accept, or reject changes.',
  collaborator: 'You are a Follower: you can suggest changes, and the Master Planner approves them.',
};

function canReviewRole(role: TripRole | null) {
  return role === 'owner';
}

function formatPatchPreview(patch: TripProposal['patchData']) {
  if (!patch.edits || patch.edits.length === 0) return 'No specific edits generated.';
  return patch.edits.map((edit) => {
    switch (edit.action) {
      case 'replace_stop':
        return `Replace ${edit.targetStopName || 'a stop'} with ${edit.newDetails?.name || 'new stop'} on Day ${edit.dayNumber}`;
      case 'add_stop':
        return `Add ${edit.newDetails?.name || 'new stop'} to Day ${edit.dayNumber}${edit.newDetails?.time_slot ? ` (${edit.newDetails.time_slot})` : ''}`;
      case 'remove_stop':
        return `Remove ${edit.targetStopName || 'a stop'} from Day ${edit.dayNumber}`;
      case 'update_note':
        return `Update note for ${edit.targetStopName || 'a stop'} on Day ${edit.dayNumber}`;
      default:
        return `Edit on Day ${edit.dayNumber}`;
    }
  }).join(' • ');
}

// Days a proposal touches, derived from its patch edits.
function proposalDays(proposal: TripProposal): number[] {
  const days = (proposal.patchData?.edits || [])
    .map((edit) => edit.dayNumber)
    .filter((day) => Number.isFinite(day));
  return Array.from(new Set(days));
}

const PROPOSAL_STATUS_STYLES: Record<TripProposal['status'], string> = {
  pending: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
  accepted: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  rejected: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
};

function ProposalCard({
  proposal,
  canReview,
  canEdit,
  actionId,
  onReview,
  onEdit,
  onWithdraw,
}: {
  proposal: TripProposal;
  canReview: boolean;
  canEdit: boolean;
  actionId: string | null;
  onReview: (proposalId: string, action: 'accept' | 'reject') => void;
  onEdit: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdraw: (proposalId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.suggestedPrompt);
  const [regenerating, setRegenerating] = useState(false);
  const pending = proposal.status === 'pending';

  const saveEdit = async () => {
    if (!draft.trim() || regenerating) return;
    setRegenerating(true);
    const ok = await onEdit(proposal.id, draft.trim());
    setRegenerating(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-2.5 bg-white dark:bg-gray-800 space-y-2">
      {editing ? (
        <div className="space-y-2">
          <AutoGrowTextarea
            value={draft}
            onChange={setDraft}
            onSubmit={saveEdit}
            placeholder="Describe the change..."
            disabled={regenerating}
            ariaLabel="Edit this suggestion"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              onClick={saveEdit}
              disabled={regenerating || !draft.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {regenerating ? <span className="animate-spin">⟳</span> : <Sparkles size={13} />}
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(proposal.suggestedPrompt); }}
              disabled={regenerating}
              className="px-3 py-1.5 text-[13px] font-medium rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[13px] text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">&ldquo;{proposal.suggestedPrompt}&rdquo;</div>
      )}

      <div className="text-[12px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 rounded-lg p-2">
        <span className="font-medium text-gray-600 dark:text-gray-300">AI patch:</span> {formatPatchPreview(proposal.patchData)}
      </div>

      {canReview && pending ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onReview(proposal.id, 'accept')}
            disabled={actionId === proposal.id}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 disabled:opacity-60"
          >
            {actionId === proposal.id ? <span className="animate-spin">⟳</span> : <CheckSquare size={13} />}
            Accept
          </button>
          <button
            onClick={() => onReview(proposal.id, 'reject')}
            disabled={actionId === proposal.id}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-60"
          >
            {actionId === proposal.id ? <span className="animate-spin">⟳</span> : <X size={13} />}
            Reject
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] inline-flex items-center px-2 py-0.5 rounded-full ${PROPOSAL_STATUS_STYLES[proposal.status]}`}>
            {proposal.status}
          </span>
          {proposal.reviewedAt && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {formatDateTime(proposal.reviewedAt)}
            </span>
          )}
          {/* Changing your mind: a rejection can be reversed, since the itinerary
              was never touched. An acceptance can't — the change is already in. */}
          {canReview && proposal.status === 'rejected' && (
            <button
              onClick={() => onReview(proposal.id, 'accept')}
              disabled={actionId === proposal.id}
              className="text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
              title="Apply this change to the itinerary"
            >
              {actionId === proposal.id ? 'Applying…' : 'Accept anyway'}
            </button>
          )}
        </div>
      )}

      {canEdit && pending && !editing && (
        <div className="flex items-center gap-3 pt-0.5">
          <button
            onClick={() => setEditing(true)}
            className="text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Edit & regenerate
          </button>
          <button
            onClick={() => onWithdraw(proposal.id)}
            className="text-[12px] font-medium text-gray-400 dark:text-gray-500 hover:text-red-600 hover:underline"
          >
            Withdraw
          </button>
        </div>
      )}
    </div>
  );
}

// Per-day "Suggest a change" box, rendered under that day's comment thread.
function DayProposalBox({
  day,
  role,
  proposals,
  submitting,
  onSubmit,
  onPreview,
  onSendApproved,
  onReview,
  onEdit,
  onWithdraw,
  actionId,
  userId,
}: {
  day: number;
  role: TripRole | null;
  proposals: TripProposal[];
  submitting: boolean;
  onPreview: (day: number, prompt: string) => Promise<PatchPreview | null>;
  onSendApproved: (day: number, prompt: string, patch: ItineraryPatch) => Promise<boolean>;
  onSubmit: (day: number, prompt: string) => Promise<boolean>;
  onReview: (proposalId: string, action: 'accept' | 'reject') => void;
  onEdit: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdraw: (proposalId: string) => void;
  actionId: string | null;
  userId?: string;
}) {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<PatchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const canReview = canReviewRole(role);
  // Only the suggester whose change needs someone else's approval confirms it
  // first — the Master Planner reviews their own suggestions in the same panel.
  const needsConfirm = role === 'collaborator';

  if (role === null) return null;

  const submit = async () => {
    if (!input.trim() || submitting || previewing) return;

    if (!needsConfirm) {
      if (await onSubmit(day, input)) setInput('');
      return;
    }

    setPreviewing(true);
    const result = await onPreview(day, input);
    setPreviewing(false);
    if (result) setPreview(result);
  };

  const confirmSend = async () => {
    if (!preview || sending) return;
    setSending(true);
    const ok = await onSendApproved(day, preview.prompt, preview.patch);
    setSending(false);
    if (ok) {
      setPreview(null);
      setInput('');
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700/50 space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        <Sparkles size={12} className="text-blue-600" /> Suggest a change
      </div>
      {preview ? (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800/50 bg-blue-50/60 dark:bg-blue-900/15 p-2.5 space-y-2">
          <div className="text-[12px] font-semibold text-gray-900 dark:text-gray-100">
            Send this to the Master Planner?
          </div>
          <div className="text-[13px] text-gray-700 dark:text-gray-300">&ldquo;{preview.prompt}&rdquo;</div>
          <div className="text-[12px] text-gray-600 dark:text-gray-400 bg-white/70 dark:bg-gray-900/40 rounded-lg p-2">
            <span className="font-medium text-gray-600 dark:text-gray-300">AI patch:</span> {formatPatchPreview(preview.patch)}
          </div>
          {!preview.wouldChange && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2 py-1.5">
              This doesn&apos;t match anything in the itinerary yet, so the Master Planner may not be
              able to apply it. Naming the day or the exact stop usually helps.
            </div>
          )}
          {/* Same deterministic checks the generation pipeline runs. `feedback`
              is what would make the pipeline regenerate; `advisory` is a hint. */}
          {!!preview.findings?.feedback.length && (
            <div className="text-[11px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5 space-y-1">
              <div className="font-semibold">This would be flagged by the itinerary checks:</div>
              {preview.findings.feedback.map((f, i) => (
                <div key={i}>• {f}</div>
              ))}
            </div>
          )}
          {!!preview.findings?.advisory.length && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2 py-1.5 space-y-1">
              <div className="font-semibold">Worth a look:</div>
              {preview.findings.advisory.map((f, i) => (
                <div key={i}>• {f}</div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPreview(null)}
              disabled={sending}
              className="flex-1 px-3 py-1.5 text-[13px] font-medium rounded-lg text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmSend}
              disabled={sending}
              className="flex-1 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {sending ? <span className="animate-spin">⟳</span> : <Check size={13} />}
              Send for approval
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <AutoGrowTextarea
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder="Change something..."
              disabled={submitting || previewing}
              ariaLabel={`Suggest a change for Day ${day}`}
            />
            <button
              onClick={submit}
              disabled={submitting || previewing || !input.trim()}
              className="flex-shrink-0 px-3.5 py-2 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {submitting || previewing ? <span className="animate-spin">⟳</span> : <Sparkles size={13} />}
              {previewing ? 'Drafting…' : 'Suggest'}
            </button>
          </div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {role === 'collaborator'
              ? 'You’ll see the AI’s change before it’s sent to the Master Planner.'
              : 'Enter to send · Shift+Enter for a new line.'}
          </div>
        </>
      )}
      {proposals.length > 0 && (
        <div className="space-y-2 pt-1">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              canReview={canReview}
              canEdit={!!userId && proposal.proposedByUserId === userId}
              actionId={actionId}
              onReview={onReview}
              onEdit={onEdit}
              onWithdraw={onWithdraw}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Suggestions whose patch doesn't land on a day that's still in the itinerary.
function UnassignedProposals({
  role,
  proposals,
  onReview,
  onEdit,
  onWithdraw,
  actionId,
  userId,
}: {
  role: TripRole | null;
  proposals: TripProposal[];
  onReview: (proposalId: string, action: 'accept' | 'reject') => void;
  onEdit: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdraw: (proposalId: string) => void;
  actionId: string | null;
  userId?: string;
}) {
  if (proposals.length === 0 || role === null) return null;
  return (
    <div className="border-t border-gray-200 dark:border-gray-700/50 pt-4 space-y-2">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        <UserCog size={14} /> Other suggestions
      </div>
      {proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          canReview={canReviewRole(role)}
          canEdit={!!userId && proposal.proposedByUserId === userId}
          actionId={actionId}
          onReview={onReview}
          onEdit={onEdit}
          onWithdraw={onWithdraw}
        />
      ))}
    </div>
  );
}

// Review queue so a Master Planner can approve everything in one place,
// instead of hunting through each day panel.
function PendingSuggestionsModal({
  proposals,
  actionId,
  onReview,
  onEdit,
  onWithdraw,
  onClose,
  userId,
}: {
  proposals: TripProposal[];
  actionId: string | null;
  onReview: (proposalId: string, action: 'accept' | 'reject') => void;
  onEdit: (proposalId: string, prompt: string) => Promise<boolean>;
  onWithdraw: (proposalId: string) => void;
  onClose: () => void;
  userId?: string;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[85dvh] overflow-y-auto overscroll-contain rounded-[20px] border border-black/[0.05] dark:border-white/[0.1] bg-white dark:bg-[#2c2c2e] shadow-[0_20px_70px_rgba(0,0,0,0.2)] p-4 md:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
            <UserCog size={18} className="text-amber-600" /> Waiting for approval ({proposals.length})
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1">
            <X size={18} />
          </button>
        </div>
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          Accepting applies the AI patch to the itinerary. Rejecting leaves it unchanged.
        </p>
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            canReview
            canEdit={!!userId && proposal.proposedByUserId === userId}
            actionId={actionId}
            onReview={onReview}
            onEdit={onEdit}
            onWithdraw={onWithdraw}
          />
        ))}
      </div>
    </div>
  );
}

// --- Sharing / invites ---

interface TripMember {
  userId: string;
  role: TripRole;
  isCreator: boolean;
  joinedAt: string;
  name?: string | null;
  email?: string | null;
  imageUrl?: string | null;
}

function shortUserId(userId: string) {
  return userId.length > 14 ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : userId;
}

// Prefer the Clerk name, then email, then a shortened ID as a last resort.
function memberLabel(member: TripMember) {
  return member.name || member.email || shortUserId(member.userId);
}

function TripSharingModal({
  trip,
  onClose,
  onTransferred,
}: {
  trip: SavedTrip;
  onClose: () => void;
  /** `leftTrip` is true when the outgoing Master Planner gave up their access. */
  onTransferred: (leftTrip: boolean) => void;
}) {
  const { user } = useUser();
  const [inviteUrl, setInviteUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<TripMember[]>([]);
  const [error, setError] = useState('');
  const [transferring, setTransferring] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/saved-trips/${trip.id}/members`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data.members)) setMembers(data.members); })
      .catch(() => {});
  }, [trip.id]);

  const transferTo = async (member: TripMember) => {
    const name = memberLabel(member);
    const keepMe = window.confirm(
      `Make ${name} the Master Planner of this trip?\n\n` +
        `They will be able to approve or reject suggestions, invite people, remove members, and delete the trip.\n\n` +
        `OK = you stay on the trip as a Follower.\nCancel = nothing changes.`,
    );
    if (!keepMe) return;

    setTransferring(member.userId);
    setError('');
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: member.userId, keepPreviousOwner: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to transfer the trip');
      onTransferred(false);
    } catch (err: any) {
      setError(err.message || 'Failed to transfer the trip');
    }
    setTransferring(null);
  };

  const createInvite = async () => {
    setCreating(true);
    setError('');
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/invites`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create invite');
      setInviteUrl(`${window.location.origin}${data.invite.url}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create invite');
    }
    setCreating(false);
  };

  const copyInvite = () => {
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const removeMember = async (userId: string) => {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    await fetch(`/api/saved-trips/${trip.id}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
      .catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md max-h-[85dvh] overflow-y-auto overscroll-contain rounded-[20px] border border-black/[0.05] dark:border-white/[0.1] bg-white dark:bg-[#2c2c2e] shadow-[0_20px_70px_rgba(0,0,0,0.2)] p-4 md:p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
            <UserPlus size={18} className="text-blue-600" /> Invite to {trip.destination || 'trip'}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1">
            <X size={18} />
          </button>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
          <div className="text-[13px] font-medium text-gray-900 dark:text-gray-100">Invite as a Follower</div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
            Followers can comment and suggest changes. Only you, the Master Planner, can approve them.
          </p>
        </div>

        {inviteUrl ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteUrl}
                className="flex-1 min-w-0 text-[13px] border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-2.5 py-2"
              />
              <button
                onClick={copyInvite}
                className="flex-shrink-0 px-3 py-2 text-[13px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-1.5"
              >
                {copied ? <Check size={14} /> : <Link2 size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">
              Anyone with this link joins as a Follower after signing in. Links expire in 30 days.
            </p>
          </div>
        ) : (
          <button
            onClick={createInvite}
            disabled={creating}
            className="w-full bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {creating ? <span className="animate-spin">⟳</span> : <Link2 size={15} />}
            {creating ? 'Creating link...' : 'Create invite link'}
          </button>
        )}

        {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}

        <div className="border-t border-gray-100 dark:border-gray-700/50 pt-3 space-y-2">
          <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            On this trip ({members.length})
          </div>
          {members.map((member) => (
            <div key={member.userId} className="flex items-center gap-2">
              {member.imageUrl ? (
                <img src={member.imageUrl} alt="" className="w-6 h-6 rounded-full flex-shrink-0 object-cover" />
              ) : (
                <div className="w-6 h-6 rounded-full flex-shrink-0 bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[10px] font-semibold text-gray-500 dark:text-gray-400">
                  {memberLabel(member).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-gray-700 dark:text-gray-300 truncate">
                  {memberLabel(member)}
                  {member.userId === user?.id && <span className="text-gray-400"> (you)</span>}
                </div>
                {member.name && member.email && (
                  <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{member.email}</div>
                )}
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 ${ROLE_BADGE_STYLES[member.role]}`}>
                {ROLE_LABELS[member.role]}
              </span>
              {/* This modal is only reachable by owner-level viewers (the Invite
                  button is gated on canReviewRole), and the API re-checks. */}
              {!member.isCreator && (
                <button
                  onClick={() => transferTo(member)}
                  disabled={transferring !== null}
                  className="text-gray-400 hover:text-blue-600 p-1 flex-shrink-0 disabled:opacity-40"
                  title="Make this person the Master Planner"
                >
                  {transferring === member.userId
                    ? <span className="animate-spin text-[11px]">⟳</span>
                    : <Crown size={13} />}
                </button>
              )}
              {!member.isCreator && (
                <button
                  onClick={() => removeMember(member.userId)}
                  className="text-gray-400 hover:text-red-600 p-1 flex-shrink-0"
                  title="Remove from trip"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- SavedTripCard ---

type TripTab = 'itinerary' | 'weather' | 'routes' | 'flights' | 'packing' | 'todos' | 'notes';

// Short labels keep more tabs visible at once on a phone.
const TRIP_TABS: { key: TripTab; label: string; icon: typeof Plane }[] = [
  { key: 'itinerary', label: 'Plan', icon: List },
  { key: 'weather', label: 'Weather', icon: Sun },
  { key: 'routes', label: 'Routes', icon: Map },
  { key: 'flights', label: 'Bookings', icon: Plane },
  { key: 'packing', label: 'Packing', icon: Briefcase },
  { key: 'todos', label: 'To-dos', icon: CheckSquare },
  { key: 'notes', label: 'Notes', icon: StickyNote },
];

// Rendered above the scroll area so the tabs stay put — inside the scrolling card
// they pinned to the scrollport and content slid underneath them.
function TripTabBar({
  activeTab,
  onChange,
}: {
  activeTab: TripTab;
  onChange: (tab: TripTab) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  // Keep the selected tab in view when the bar is wider than the screen.
  useEffect(() => {
    const active = barRef.current?.querySelector('[data-tab-active="true"]') as HTMLElement | null;
    active?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [activeTab]);

  return (
    <div
      ref={barRef}
      role="tablist"
      className="flex overflow-x-auto scrollbar-hide"
    >
      {TRIP_TABS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          role="tab"
          onClick={() => onChange(key)}
          data-tab-active={activeTab === key}
          aria-selected={activeTab === key}
          className={`flex-shrink-0 px-3 md:px-4 py-2 md:flex-1 text-[13px] font-medium whitespace-nowrap min-h-[48px] flex items-center justify-center gap-1.5 ${
            activeTab === key
              ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 bg-blue-50 dark:bg-blue-900/20'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
          }`}
        >
          <Icon size={15} className="flex-shrink-0" />
          {label}
        </button>
      ))}
    </div>
  );
}

// Icon button with a real tooltip. The native `title` tooltip takes a second to
// appear and never shows on touch, so these read as unlabelled icons.
function HeaderIconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative group flex items-center">
      <button
        onClick={onClick}
        aria-label={label}
        className={`w-10 h-10 md:w-auto md:h-auto md:p-1.5 rounded-lg transition-colors flex items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 ${
          danger ? 'hover:text-red-600' : 'hover:text-blue-600'
        }`}
      >
        {children}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full mt-1.5 z-20 whitespace-nowrap rounded-lg bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 dark:bg-gray-700"
      >
        {label}
      </span>
    </div>
  );
}

function SavedTripCard({ trip, onUpdate, onDelete, onLeave, onPayloadRefresh, isSignedIn, isOpen, activeTab }: { trip: SavedTrip; onUpdate: (trip: SavedTrip) => void; onDelete?: () => void; onLeave?: () => void; onPayloadRefresh: (tripId: string, payload: ChatPayload) => void; isSignedIn: boolean; isOpen: boolean; activeTab: TripTab }) {
  const { user } = useUser();
  // Leaving and deleting are both destructive, so ask first.
  const [confirming, setConfirming] = useState<'leave' | 'delete' | null>(null);
  const [todoText, setTodoText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [proposals, setProposals] = useState<TripProposal[]>([]);
  const [proposalRole, setProposalRole] = useState<TripRole | null>(null);
  const [submittingDay, setSubmittingDay] = useState<number | null>(null);
  const [proposalActionId, setProposalActionId] = useState<string | null>(null);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Pull the latest suggestions and itinerary. Used by the 30s poll below and
  // after a 409, when another reviewer changed the trip under us.
  const syncFromServer = useCallback(async () => {
    try {
      const proposalsRes = await fetch(`/api/saved-trips/${trip.id}/proposals`);
      const data = await proposalsRes.json();
      if (data.role) setProposalRole(data.role);
      if (Array.isArray(data.proposals)) setProposals(data.proposals);
    } catch { /* keep what we have */ }

    try {
      const tripRes = await fetch(`/api/saved-trips/${trip.id}`);
      const data = await tripRes.json();
      const fresh = data.trip?.payload?.itinerary;
      if (typeof fresh === 'string' && fresh !== trip.payload.itinerary) {
        onPayloadRefresh(trip.id, data.trip.payload);
      }
    } catch { /* keep what we have */ }
  }, [trip.id, trip.payload.itinerary, onPayloadRefresh]);

  // Load collaboration role and pending proposals for this trip, and keep
  // refreshing while One Stop is open so new suggestions — and itinerary
  // changes accepted by another collaborator — show up without a reload.
  useEffect(() => {
    if (!isSignedIn) return;
    syncFromServer();
    if (!isOpen) return;

    const interval = setInterval(syncFromServer, 30000);
    return () => clearInterval(interval);
  }, [isSignedIn, isOpen, syncFromServer]);

  const pendingProposals = proposals.filter((p) => p.status === 'pending');

  // Drafts the AI patch without sending it, so the suggester can check it first.
  const previewProposal = async (day: number, prompt: string): Promise<PatchPreview | null> => {
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), dayIndex: day }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Could not draft a suggestion from that.');
        return null;
      }
      return data.preview || null;
    } catch {
      alert('Could not draft a suggestion from that.');
      return null;
    }
  };

  // day is passed so the AI targets that day; the stored prompt stays as typed.
  // A reviewed patch is sent back verbatim so the Master Planner sees exactly
  // what was confirmed.
  const submitProposal = async (day: number, prompt: string, patch?: ItineraryPatch): Promise<boolean> => {
    if (!prompt.trim() || submittingDay !== null) return false;
    setSubmittingDay(day);
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), dayIndex: day, patch }),
      });
      const data = await res.json();
      if (data.proposal) {
        setProposals((prev) => [...prev, data.proposal]);
        setSubmittingDay(null);
        return true;
      }
    } catch { /* ignore */ }
    setSubmittingDay(null);
    return false;
  };

  // Reword a pending suggestion; the AI regenerates the patch in place.
  const editProposal = async (proposalId: string, prompt: string): Promise<boolean> => {
    setProposalActionId(proposalId);
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals/${proposalId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to regenerate this suggestion.');
        setProposalActionId(null);
        return false;
      }
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? data.proposal : p)));
      setProposalActionId(null);
      return true;
    } catch {
      setProposalActionId(null);
      return false;
    }
  };

  const withdrawProposal = async (proposalId: string) => {
    const snapshot = proposals;
    setProposals((prev) => prev.filter((p) => p.id !== proposalId));
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals/${proposalId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to withdraw this suggestion.');
        setProposals(snapshot);
      }
    } catch {
      setProposals(snapshot);
    }
  };

  const reviewProposal = async (proposalId: string, action: 'accept' | 'reject') => {
    setProposalActionId(proposalId);
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals/${proposalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to review this suggestion.');
        // 409 means another reviewer acted first, or the trip moved on while we
        // were applying it — pull the current state instead of showing stale UI.
        if (res.status === 409) await syncFromServer();
        setProposalActionId(null);
        return;
      }
      if (action === 'accept' && data.trip) {
        // Accepting a previously rejected suggestion applies it now, so refresh
        // the itinerary from the response rather than waiting for the next poll.
        onPayloadRefresh(trip.id, data.trip.payload);
      }
      if (data.proposal) {
        setProposals((prev) => prev.map((p) => (p.id === proposalId ? data.proposal : p)));
      }
    } catch { /* ignore */ }
    setProposalActionId(null);
  };

  const addTodo = () => {
    if (!todoText.trim()) return;
    onUpdate({
      ...trip,
      todos: [...trip.todos, { id: crypto.randomUUID(), text: todoText.trim(), done: false }],
    });
    setTodoText('');
  };

  const toggleTodo = (id: string) => {
    onUpdate({
      ...trip,
      todos: trip.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    });
  };

  const deleteTodo = (id: string) => {
    onUpdate({
      ...trip,
      todos: trip.todos.filter((t) => t.id !== id),
    });
  };

  const updateNotes = (notes: string) => {
    onUpdate({ ...trip, notes });
  };

  const addNote = () => {
    if (!noteText.trim()) return;
    const entry: NoteEntry = {
      id: crypto.randomUUID(),
      text: noteText.trim(),
      createdAt: new Date().toISOString(),
    };
    onUpdate({ ...trip, noteEntries: [...(trip.noteEntries || []), entry] });
    setNoteText('');
  };

  const deleteNote = (id: string) => {
    onUpdate({ ...trip, noteEntries: (trip.noteEntries || []).filter((n) => n.id !== id) });
  };

  const copyToClipboard = () => {
    const text = buildTripSummary(trip);
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const payload = trip.payload;

  return (
    // overflow-clip (not hidden) so the sticky tab bar can stick to the page
    // scroller instead of being trapped in a non-scrolling container.
    <div className="border border-black/[0.05] dark:border-white/[0.1] rounded-[20px] bg-white dark:bg-[#2c2c2e] shadow-[0_8px_30px_rgba(0,0,0,0.08)] overflow-clip">
      {trip.weatherAlert && (
        <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/40 px-4 py-3 rounded-t-[20px]">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 text-[13px] leading-snug text-amber-800 dark:text-amber-200">
            <span className="font-semibold">Weather alert</span>
            <p className="mt-0.5 break-words">{trip.weatherAlert}</p>
          </div>
        </div>
      )}
      <div className={`p-3 md:p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex items-start justify-between gap-2 md:gap-3 ${trip.weatherAlert ? '' : 'rounded-t-[20px]'}`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
              <MapPin size={16} className="text-blue-600" />
              {trip.destination || 'Trip'}
            </div>
            {proposalRole && (
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${ROLE_BADGE_STYLES[proposalRole]}`}
                title={ROLE_TOOLTIPS[proposalRole]}
              >
                <UserCog size={11} />
                {ROLE_LABELS[proposalRole]}
              </span>
            )}
            {canReviewRole(proposalRole) && pendingProposals.length > 0 && (
              <button
                onClick={() => setReviewOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                title="Review suggested changes"
              >
                <UserCog size={11} />
                {pendingProposals.length} waiting for approval
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mt-1">
            <Calendar size={14} />
            {trip.dates || 'Dates TBD'}
          </div>
          {proposalRole === 'collaborator' && (
            <div className="text-[12px] text-purple-600 dark:text-purple-400 mt-1">
              Suggest changes on any day — the Master Planner reviews them.
            </div>
          )}
        </div>
        <div className="relative flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          <HeaderIconAction label="Copy trip summary" onClick={copyToClipboard}>
            <Clipboard size={18} className="md:hidden" />
            <Clipboard size={16} className="hidden md:block" />
          </HeaderIconAction>

          {canReviewRole(proposalRole) && (
            <HeaderIconAction label="Invite people to this trip" onClick={() => setSharingOpen(true)}>
              <UserPlus size={18} className="md:hidden" />
              <UserPlus size={16} className="hidden md:block" />
            </HeaderIconAction>
          )}

          {proposalRole && proposalRole !== 'owner' && onLeave ? (
            <HeaderIconAction label="Leave this trip" danger onClick={() => setConfirming('leave')}>
              <LogOut size={18} className="md:hidden" />
              <LogOut size={16} className="hidden md:block" />
            </HeaderIconAction>
          ) : (
            onDelete && (
              <HeaderIconAction label="Delete trip" danger onClick={() => setConfirming('delete')}>
                <Trash2 size={18} className="md:hidden" />
                <Trash2 size={16} className="hidden md:block" />
              </HeaderIconAction>
            )
          )}

          {confirming && (
            <>
              {/* Click anywhere else to dismiss without acting. */}
              <div className="fixed inset-0 z-20" onClick={() => setConfirming(null)} />
              <div className="absolute right-0 top-full mt-2 z-30 w-64 rounded-xl border border-black/[0.06] dark:border-white/[0.12] bg-white dark:bg-[#2c2c2e] p-3 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
                <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
                  {confirming === 'leave' ? 'Leave this trip?' : 'Delete this trip?'}
                </p>
                <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
                  {confirming === 'leave'
                    ? 'It stays in the Master Planner’s One Stop. You’ll need a new invite link to come back.'
                    : 'This removes the trip for everyone on it, and can’t be undone.'}
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => setConfirming(null)}
                    className="flex-1 px-3 py-1.5 text-[13px] font-medium rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const action = confirming;
                      setConfirming(null);
                      if (action === 'leave') onLeave?.();
                      else onDelete?.();
                    }}
                    className="flex-1 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-red-600 text-white hover:bg-red-700"
                  >
                    {confirming === 'leave' ? 'Leave' : 'Delete'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="p-3 md:p-4">
        {activeTab === 'itinerary' && (
          <ItineraryTab
            trip={trip}
            onUpdate={onUpdate}
            proposalRole={proposalRole}
            proposals={proposals}
            submittingDay={submittingDay}
            onSubmitProposal={submitProposal}
            onPreviewProposal={previewProposal}
            onSendApprovedProposal={submitProposal}
            onReviewProposal={reviewProposal}
            onEditProposal={editProposal}
            onWithdrawProposal={withdrawProposal}
            proposalActionId={proposalActionId}
            userId={user?.id}
          />
        )}

        {activeTab === 'weather' && (
          <WeatherTab trip={trip} />
        )}

        {activeTab === 'routes' && (
          <div className="space-y-3">
            {payload.transportPlan?.days && payload.transportPlan.days.length > 0 && (
              <OneStopRouteMap days={payload.transportPlan.days} routeLinks={payload.routeLinks} />
            )}
            {payload.routeLinks && payload.routeLinks.length > 0 ? (
              payload.routeLinks.map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-4 hover:border-blue-500/40 hover:shadow-md active:scale-95 transition-all duration-200 ease-out no-underline"
                >
                  <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                    <Map size={16} className="text-blue-600" />
                    Day {link.day}: {link.title || 'Route'}
                  </div>
                  <div className="text-[13px] text-blue-600 dark:text-blue-400 mt-1">Open in Google Maps →</div>
                </a>
              ))
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">No routes saved.</div>
            )}
          </div>
        )}

        {activeTab === 'flights' && (
          <FlightsDocsTab trip={trip} onUpdate={onUpdate} />
        )}

        {activeTab === 'packing' && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
            {payload.packingTips ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-0.5">{children}</ol>,
                  strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                }}
              >
                {payload.packingTips}
              </ReactMarkdown>
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">No packing list saved.</div>
            )}
          </div>
        )}

        {activeTab === 'todos' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={todoText}
                onChange={(e) => setTodoText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTodo()}
                placeholder="Add a to-do..."
                className="flex-1 min-w-0 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              <button
                onClick={addTodo}
                disabled={!todoText.trim()}
                className="flex-shrink-0 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Plus size={15} /> Add
              </button>
            </div>
            <div className="space-y-2">
              {trip.todos.length === 0 ? (
                <div className="text-sm text-gray-400 dark:text-gray-500">No to-dos yet.</div>
              ) : (
                trip.todos.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 group">
                    <button onClick={() => toggleTodo(t.id)} className="text-blue-600 dark:text-blue-400">
                      {t.done ? <CheckSquare size={18} /> : <Square size={18} />}
                    </button>
                    <span className={`flex-1 text-sm ${t.done ? 'line-through text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'}`}>
                      {t.text}
                    </span>
                    <button
                      onClick={() => deleteTodo(t.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 dark:text-gray-500 hover:text-red-600 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="space-y-4">
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
                placeholder="Add a note (e.g. 'Book the ferry in advance')..."
                className="flex-1 min-w-0 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              <button
                onClick={addNote}
                disabled={!noteText.trim()}
                className="flex-shrink-0 px-4 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Plus size={15} /> Add note
              </button>
            </div>

            {(trip.noteEntries || []).length === 0 ? (
              <div className="text-sm text-gray-400 dark:text-gray-500">No notes yet.</div>
            ) : (
              <div className="space-y-2">
                {(trip.noteEntries || []).map((note) => (
                  <div
                    key={note.id}
                    className="flex items-start gap-2 group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"
                  >
                    <StickyNote size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">{note.text}</div>
                      <div className="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{formatDateTime(note.createdAt)}</div>
                    </div>
                    <button
                      onClick={() => deleteNote(note.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1 flex-shrink-0"
                      title="Delete note"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Older trips stored a single freeform notes field — keep it editable. */}
            {trip.notes && (
              <div className="space-y-2 border-t border-gray-100 dark:border-gray-700/50 pt-3">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  <StickyNote size={13} /> Trip notes
                </div>
                <textarea
                  value={trip.notes}
                  onChange={(e) => updateNotes(e.target.value)}
                  placeholder="Write your notes here..."
                  className="w-full h-32 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg p-3 focus:outline-none focus:border-blue-400 resize-none"
                />
              </div>
            )}
          </div>
        )}

      </div>

      {sharingOpen && (
        <TripSharingModal
          trip={trip}
          onClose={() => setSharingOpen(false)}
          onTransferred={(leftTrip) => {
            setSharingOpen(false);
            // Handing the trip over changes this viewer's role, so re-read it.
            if (leftTrip) onLeave?.();
            else syncFromServer();
          }}
        />
      )}

      {reviewOpen && (
        <PendingSuggestionsModal
          proposals={pendingProposals}
          actionId={proposalActionId}
          onReview={reviewProposal}
          onEdit={editProposal}
          onWithdraw={withdrawProposal}
          onClose={() => setReviewOpen(false)}
          userId={user?.id}
        />
      )}
    </div>
  );
}

function buildTripSummary(trip: SavedTrip): string {
  const p = trip.payload;
  let summary = `${trip.destination} — ${trip.dates}\n\n`;
  if (p.itinerary) summary += `Itinerary:\n${p.itinerary}\n\n`;
  if (p.routeLinks && p.routeLinks.length > 0) {
    summary += `Routes:\n${p.routeLinks.map((r) => `- Day ${r.day}: ${r.url}`).join('\n')}\n\n`;
  }
  if (p.packingTips) summary += `Packing:\n${p.packingTips}\n\n`;
  if (trip.noteEntries && trip.noteEntries.length > 0) {
    summary += `Notes:\n${trip.noteEntries.map((n) => `- ${n.text}`).join('\n')}\n\n`;
  }
  if (trip.notes) summary += `Trip notes:\n${trip.notes}\n\n`;
  if (trip.todos.length > 0) summary += `To-dos:\n${trip.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}\n`;
  if (trip.flightInfo && trip.flightInfo.length > 0) {
    summary += `\nBookings:\n${trip.flightInfo.map((e) => `- ${e.label} (${e.airlineOrProvider}) · ${e.confirmationCode || 'no ref'}`).join('\n')}\n`;
  }
  return summary;
}

function OneStopRouteMap({ days, routeLinks }: { days: DayTransport[]; routeLinks?: RouteLink[] }) {
  const [activeDay, setActiveDay] = useState(days[0]?.day || '1');
  const activeDayData = days.find((d) => d.day === activeDay) || days[0];
  // The Google Maps link for whichever day is selected — put it next to the
  // day chips so it's visible without scrolling past the map.
  const activeLink = routeLinks?.find((link) => link.day === activeDay);
  if (!activeDayData) return null;
  return (
    <div className="border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-3">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {days.map((d) => (
            <button
              key={d.day}
              onClick={() => setActiveDay(d.day)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                activeDay === d.day
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-[#2c2c2e] text-gray-700 dark:text-gray-200 border-black/[0.05] dark:border-white/[0.1] hover:border-blue-500/40'
              }`}
            >
              Day {d.day}
            </button>
          ))}
        </div>
        {activeLink && (
          <a
            href={activeLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium bg-blue-50 dark:bg-blue-900/25 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50 hover:bg-blue-100 dark:hover:bg-blue-900/40 no-underline whitespace-nowrap"
            title={activeLink.highlights || 'Open this day in Google Maps'}
          >
            <Navigation size={13} /> Google Maps
          </a>
        )}
      </div>
      <DailyRouteMap waypoints={activeDayData.waypoints} polyline={activeDayData.polyline} />
    </div>
  );
}

export default function OneStopPanel({ isOpen, onClose, savedTrips, setSavedTrips, isSignedIn }: OneStopPanelProps) {
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  // The selected tab lives here so the tab bar can sit above the scroll area.
  const [activeTab, setActiveTab] = useState<TripTab>('itinerary');
  const [view, setView] = useState<'trips' | 'alerts'>('trips');
  const [alerts, setAlerts] = useState<any[]>([]);
  const [alertForm, setAlertForm] = useState({ origin: '', destination: '', cabin: '', month: '', minCPP: '1.5' });
  const [creatingAlert, setCreatingAlert] = useState(false);

  const updateTrip = (updated: SavedTrip) => {
    setSavedTrips((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    // Sync to server if signed in.
    if (isSignedIn) {
      fetch(`/api/saved-trips/${updated.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          todos: updated.todos,
          notes: updated.notes,
          noteEntries: updated.noteEntries || [],
          feedback: updated.feedback || {},
          dayFeedback: updated.dayFeedback || {},
          flightInfo: updated.flightInfo || [],
          documents: updated.documents || [],
        }),
      }).catch(() => { /* silent fail — local state is already updated */ });
    }
  };

  const deleteTrip = (id: string) => {
    setSavedTrips((prev) => prev.filter((t) => t.id !== id));
    if (activeTripId === id) setActiveTripId(null);
    // Sync to server if signed in.
    if (isSignedIn) {
      fetch(`/api/saved-trips/${id}`, {
        method: 'DELETE',
      }).catch(() => { /* silent fail — local state is already updated */ });
    }
  };

  // Pick up an itinerary change accepted by another collaborator without
  // writing anything back — the server already has the new payload.
  const refreshTripPayload = useCallback((id: string, payload: ChatPayload) => {
    setSavedTrips((prev) => prev.map((t) => (t.id === id ? { ...t, payload } : t)));
  }, [setSavedTrips]);

  // Leaving a shared trip only removes the membership row, not the trip itself.
  const leaveTrip = (id: string) => {
    setSavedTrips((prev) => prev.filter((t) => t.id !== id));
    if (activeTripId === id) setActiveTripId(null);
    if (isSignedIn) {
      fetch(`/api/saved-trips/${id}/members/me`, { method: 'DELETE' })
        .catch(() => { /* silent fail — local state is already updated */ });
    }
  };

  // Auto-select the first trip if none is selected.
  const activeTrip = savedTrips.find((t) => t.id === activeTripId) || savedTrips[0] || null;

  // Fetch alerts when the panel opens or view switches to alerts.
  useEffect(() => {
    if (isOpen && view === 'alerts' && isSignedIn) {
      fetch('/api/deal-alerts')
        .then((r) => r.json())
        .then((data) => { if (data.alerts) setAlerts(data.alerts); })
        .catch(() => {});
    }
  }, [isOpen, view, isSignedIn]);

  const createAlert = async () => {
    setCreatingAlert(true);
    try {
      const res = await fetch('/api/deal-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: alertForm.origin.toUpperCase() || undefined,
          destination: alertForm.destination.toUpperCase() || undefined,
          cabin: alertForm.cabin || undefined,
          month: alertForm.month || undefined,
          minCPP: alertForm.minCPP || '1.5',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.alert) {
          setAlerts((prev) => [data.alert, ...prev]);
          setAlertForm({ origin: '', destination: '', cabin: '', month: '', minCPP: '1.5' });
        }
      }
    } catch { /* ignore */ }
    setCreatingAlert(false);
  };

  const deleteAlert = async (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(`/api/deal-alerts/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  };

  const toggleAlert = async (id: string, isActive: boolean) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isActive: !isActive } : a)));
    try {
      await fetch(`/api/deal-alerts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !isActive }),
      });
    } catch { /* ignore */ }
  };

  return (
    <>
      {isOpen ? (
        <div className="fixed inset-0 z-40" onClick={onClose}>
          <div className="absolute inset-0 bg-black/40" />
        </div>
      ) : null}

      <div
        className={`fixed inset-0 z-50 flex p-0 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          // Keep content clear of the notch and the home indicator on phones.
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
          className={`w-full h-[100dvh] max-w-none max-h-none bg-white dark:bg-[#1c1c1e] flex flex-col transform transition-all duration-300 ease-out overflow-hidden ${
            isOpen ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}
        >
          <div className="px-4 md:px-6 py-2 md:py-3 border-b border-black/[0.05] dark:border-white/[0.1] flex items-center justify-between bg-white/70 dark:bg-[#1c1c1e]/70 flex-shrink-0">
            <div className="flex items-center gap-2 md:gap-4 min-w-0">
              <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100 flex-shrink-0">
                <Plane size={20} className="text-blue-600" /> <span className="hidden sm:inline">One Stop</span>
              </div>
              {isSignedIn && (
                <div className="flex gap-1 ml-2">
                  <button
                    onClick={() => setView('trips')}
                    className={`min-h-[40px] md:min-h-0 px-3.5 md:px-3 py-1 text-[13px] font-medium rounded-lg transition-colors ${
                      view === 'trips'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    Trips
                  </button>
                  <button
                    onClick={() => setView('alerts')}
                    className={`min-h-[40px] md:min-h-0 px-3.5 md:px-3 py-1 text-[13px] font-medium rounded-lg transition-colors flex items-center gap-1 ${
                      view === 'alerts'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    <Bell size={12} /> Alerts
                    {alerts.length > 0 && (
                      <span className="ml-0.5 bg-blue-600 text-white text-[10px] px-1.5 rounded-full">{alerts.length}</span>
                    )}
                  </button>
                </div>
              )}
            </div>
            <button onClick={onClose} className="w-11 h-11 flex items-center justify-center rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] active:scale-95 transition-transform duration-200 ease-out" aria-label="Close One Stop">
              <X size={20} />
            </button>
          </div>

          {view === 'alerts' ? (
            /* --- Alerts View --- */
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              {!isSignedIn ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-16">
                  <Bell size={32} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
                  <p className="text-sm">Sign in to create deal alerts.</p>
                  <p className="text-[13px] mt-1 text-gray-400 dark:text-gray-500">Get email notifications when new deals match your criteria.</p>
                </div>
              ) : (
                <div className="max-w-2xl mx-auto space-y-6">
                  {/* Create alert form */}
                  <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-gray-50 dark:bg-gray-800/50">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-2">
                      <Bell size={16} className="text-blue-600" /> Create New Alert
                    </h3>
                    <p className="text-[13px] text-gray-500 dark:text-gray-400 mb-3">We'll email you when a new GOOD_DEAL matches your criteria. Leave fields blank for "any".</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Origin (IATA)</label>
                        <input
                          type="text"
                          value={alertForm.origin}
                          onChange={(e) => setAlertForm({ ...alertForm, origin: e.target.value.toUpperCase().slice(0, 3) })}
                          placeholder="SFO"
                          className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 uppercase"
                        />
                      </div>
                      <div>
                        <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Destination (IATA)</label>
                        <input
                          type="text"
                          value={alertForm.destination}
                          onChange={(e) => setAlertForm({ ...alertForm, destination: e.target.value.toUpperCase().slice(0, 3) })}
                          placeholder="NRT"
                          className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 uppercase"
                        />
                      </div>
                      <div>
                        <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Cabin</label>
                        <select
                          value={alertForm.cabin}
                          onChange={(e) => setAlertForm({ ...alertForm, cabin: e.target.value })}
                          className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                        >
                          <option value="">Any cabin</option>
                          <option value="ECONOMY">Economy</option>
                          <option value="PREMIUM_ECONOMY">Premium Economy</option>
                          <option value="BUSINESS">Business</option>
                          <option value="FIRST">First</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Month (YYYY-MM)</label>
                        <input
                          type="month"
                          value={alertForm.month}
                          onChange={(e) => setAlertForm({ ...alertForm, month: e.target.value })}
                          className="w-full text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <label className="text-[13px] text-gray-500 dark:text-gray-400 mb-1 block">Min CPP (cents per point)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.5"
                          max="5"
                          value={alertForm.minCPP}
                          onChange={(e) => setAlertForm({ ...alertForm, minCPP: e.target.value })}
                          className="w-24 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                        />
                      </div>
                      <button
                        onClick={createAlert}
                        disabled={creatingAlert}
                        className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Plus size={16} /> {creatingAlert ? 'Creating...' : 'Create Alert'}
                      </button>
                    </div>
                  </div>

                  {/* Existing alerts list */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Your Alerts ({alerts.length})</h3>
                    {alerts.length === 0 ? (
                      <div className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">
                        No alerts yet. Create one above to get notified when deals match.
                      </div>
                    ) : (
                      alerts.map((alert) => (
                        <div key={alert.id} className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-800 flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap text-sm">
                              <span className="font-medium text-gray-900 dark:text-gray-100">
                                {alert.origin || 'Any'} → {alert.destination || 'Any'}
                              </span>
                              {alert.cabin && (
                                <span className="text-[13px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                                  {alert.cabin.replace('_', ' ')}
                                </span>
                              )}
                              {alert.month && (
                                <span className="text-[13px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full">
                                  {alert.month}
                                </span>
                              )}
                              <span className="text-[13px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">
                                ≥ {alert.minCPP}¢/pt
                              </span>
                            </div>
                            {alert.lastNotifiedAt && (
                              <div className="text-[13px] text-gray-400 dark:text-gray-500 mt-1">
                                Last notified: {new Date(alert.lastNotifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 ml-3">
                            <button
                              onClick={() => toggleAlert(alert.id, alert.isActive)}
                              className={`text-[13px] px-2 py-1 rounded-lg transition-colors ${
                                alert.isActive
                                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                              }`}
                            >
                              {alert.isActive ? 'Active' : 'Paused'}
                            </button>
                            <button
                              onClick={() => deleteAlert(alert.id)}
                              className="text-gray-400 dark:text-gray-500 hover:text-red-600 p-1"
                              title="Delete alert"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : savedTrips.length === 0 ? (
            /* --- Trips View (empty) --- */
            <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400">
              <div className="text-center">
                <div className="bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 p-5 rounded-full inline-flex mb-4">
                  <Clipboard size={28} />
                </div>
                <p className="text-base">No saved trips yet.</p>
                <p className="text-sm mt-1">Save an itinerary from any assistant message, or save a shared trip.</p>
              </div>
            </div>
          ) : savedTrips.length === 1 ? (
            /* --- Trips View (single trip) --- */
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Pinned above the scroll area, so it never drifts into the content */}
              <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-[#2c2c2e] px-4 md:px-6 lg:px-8">
                <div className="mx-auto max-w-6xl">
                  <TripTabBar activeTab={activeTab} onChange={setActiveTab} />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                <div className="mx-auto max-w-6xl">
                  <SavedTripCard
                    isSignedIn={isSignedIn}
                    isOpen={isOpen}
                    activeTab={activeTab}
                    trip={savedTrips[0]}
                    onUpdate={updateTrip}
                    onPayloadRefresh={refreshTripPayload}
                    onDelete={() => deleteTrip(savedTrips[0].id)}
                    onLeave={isSignedIn ? () => leaveTrip(savedTrips[0].id) : undefined}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* --- Trips View (multiple trips) --- */
            <>
              {/* Mobile trip selector — scrollable chips instead of a dropdown */}
              <div className="md:hidden border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
                <div className="flex gap-2 overflow-x-auto scrollbar-hide px-4 py-2.5">
                  {savedTrips.map((trip) => {
                    const isActive = activeTrip?.id === trip.id;
                    return (
                      <button
                        key={trip.id}
                        onClick={() => setActiveTripId(trip.id)}
                        aria-current={isActive}
                        className={`flex-shrink-0 min-h-[44px] rounded-2xl border px-3.5 py-2 text-left transition-colors ${
                          isActive
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/25'
                            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-[#2c2c2e]'
                        }`}
                      >
                        <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${isActive ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'}`}>
                          <MapPin size={12} className={isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'} />
                          {trip.destination || 'Trip'}
                        </div>
                        <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5 truncate max-w-[140px]">
                          {trip.dates || 'Dates TBD'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                {/* Desktop trip selector sidebar (hidden on mobile) */}
                <div className="hidden md:flex w-64 lg:w-72 border-r border-gray-100 dark:border-gray-800 flex-col flex-shrink-0">
                  <div className="text-[13px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide px-4 py-3 border-b border-gray-50 dark:border-gray-800">
                    Saved Trips ({savedTrips.length})
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {savedTrips.map((trip) => (
                      <button
                        key={trip.id}
                        onClick={() => setActiveTripId(trip.id)}
                        className={`w-full text-left rounded-lg p-3 transition-colors group ${
                          activeTrip?.id === trip.id
                            ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin size={14} className={activeTrip?.id === trip.id ? 'text-blue-600' : 'text-gray-400 dark:text-gray-500'} />
                          <span className={`text-sm font-medium truncate ${activeTrip?.id === trip.id ? 'text-blue-700 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>
                            {trip.destination || 'Trip'}
                          </span>
                        </div>
                        <div className="text-[13px] text-gray-400 dark:text-gray-500 mt-1 ml-5 truncate">
                          {trip.dates || 'Dates TBD'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Active trip detail — the tab bar is pinned above the scroller */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {activeTrip && (
                    <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-[#2c2c2e] px-4 md:px-6 lg:px-8">
                      <div className="mx-auto max-w-6xl">
                        <TripTabBar activeTab={activeTab} onChange={setActiveTab} />
                      </div>
                    </div>
                  )}
                  <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="mx-auto max-w-6xl">
                      {activeTrip ? (
                        <SavedTripCard
                          isSignedIn={isSignedIn}
                          isOpen={isOpen}
                          activeTab={activeTab}
                          trip={activeTrip}
                          onUpdate={updateTrip}
                          onPayloadRefresh={refreshTripPayload}
                          onDelete={() => deleteTrip(activeTrip.id)}
                          onLeave={isSignedIn ? () => leaveTrip(activeTrip.id) : undefined}
                        />
                      ) : (
                        <div className="text-center text-gray-400 dark:text-gray-500 py-16">Select a trip.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
