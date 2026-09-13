'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import {
  X, Plus, Trash2, CheckSquare, Square, Plane, Clipboard, StickyNote,
  MapPin, Calendar, Map, Bell, ThumbsUp, ThumbsDown, MessageSquare,
  FileText, Upload, Download, Hotel, Train, Car, ChevronDown, ChevronUp,
  AlertTriangle, Sparkles, UserCog,
} from 'lucide-react';
import { useUser } from '@/components/AuthProvider';
import type {
  SavedTrip, ChatPayload, StopFeedback, StopComment, DayFeedback, DayComment,
  ManualFlightEntry, UploadedDocument, WeatherSnapshot, TripProposal,
} from '@/lib/chat-state';
import { stripFollowUpQuestions } from '@/lib/itinerary-cleanup';
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
              <div className="flex-1 text-[13px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-2.5 py-1.5">
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
              <div className="flex-1 text-[13px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-2.5 py-1.5">
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
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addComment()}
            placeholder="Add a comment..."
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
    </div>
  );
}

// --- Itinerary tab with per-day feedback ---

function ItineraryTab({ trip, onUpdate }: { trip: SavedTrip; onUpdate: (trip: SavedTrip) => void }) {
  const payload = trip.payload;
  // Saved plans shouldn't include the assistant's closing follow-up questions.
  const dayBlocks = splitItineraryByDay(stripFollowUpQuestions(payload.itinerary || ''));

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
            <div className="md:col-span-1 md:sticky md:top-4 md:self-start rounded-xl border border-gray-100 dark:border-gray-700/50 p-3 bg-gray-50/50 dark:bg-gray-800/30">
              <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Day {day}
              </div>
              <DayFeedbackBar dayIndex={day} trip={trip} onUpdate={onUpdate} />
            </div>
          </div>
        )
      )}
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

function ProposalsSection({
  role,
  proposals,
  proposalInput,
  setProposalInput,
  submittingProposal,
  onSubmit,
  onReview,
  actionId,
  userId,
}: {
  role: 'owner' | 'collaborator' | null;
  proposals: TripProposal[];
  proposalInput: string;
  setProposalInput: (value: string) => void;
  submittingProposal: boolean;
  onSubmit: () => void;
  onReview: (proposalId: string, action: 'accept' | 'reject') => void;
  actionId: string | null;
  userId?: string;
}) {
  const canSuggest = role === 'collaborator' || role === 'owner';
  const canReview = role === 'owner';
  const pending = proposals.filter((p) => p.status === 'pending');
  const myProposals = proposals.filter((p) => p.proposedByUserId === userId);

  return (
    <div className="border-t border-gray-200 dark:border-gray-700/50 pt-5 space-y-4">
      {canSuggest && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <Sparkles size={14} className="text-blue-600" /> Suggest a Change
          </div>
          <p className="text-[12px] text-gray-400 dark:text-gray-500">
            {canReview
              ? 'Describe a change and preview the AI patch before applying it.'
              : 'Describe the change you want. The trip owner will review it before it is applied.'}
          </p>
          <div className="flex items-stretch gap-2">
            <input
              type="text"
              value={proposalInput}
              onChange={(e) => setProposalInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
              placeholder="e.g. 'Swap Day 2 lunch for a vegan spot'"
              disabled={submittingProposal}
              className="flex-1 min-w-0 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 disabled:opacity-60"
            />
            <button
              onClick={onSubmit}
              disabled={submittingProposal || !proposalInput.trim()}
              className="flex-shrink-0 px-4 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {submittingProposal ? (
                <><span className="animate-spin">⟳</span> Generating…</>
              ) : (
                <><Sparkles size={14} /> Suggest</>
              )}
            </button>
          </div>
        </div>
      )}

      {!canSuggest && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 text-sm text-gray-500 dark:text-gray-400 text-center">
          Sign in to suggest or review itinerary changes.
        </div>
      )}

      {canReview && pending.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <UserCog size={14} /> Review Suggestions ({pending.length})
          </div>
          {pending.map((proposal) => (
            <div key={proposal.id} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-white dark:bg-gray-800 space-y-2">
              <div className="text-sm text-gray-900 dark:text-gray-100">"{proposal.suggestedPrompt}"</div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 rounded-lg p-2">
                <span className="font-medium text-gray-600 dark:text-gray-300">AI patch preview:</span> {formatPatchPreview(proposal.patchData)}
              </div>
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
            </div>
          ))}
        </div>
      )}

      {role === 'collaborator' && myProposals.length > 0 && (
        <div className="space-y-2">
          <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            My Pending Suggestions
          </div>
          {myProposals.map((proposal) => (
            <div key={proposal.id} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-white dark:bg-gray-800">
              <div className="text-sm text-gray-900 dark:text-gray-100">"{proposal.suggestedPrompt}"</div>
              <div className="mt-1 text-[12px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 rounded-lg p-2">
                {formatPatchPreview(proposal.patchData)}
              </div>
              <div className="mt-2 text-[12px] inline-flex items-center px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300">
                {proposal.status}
              </div>
            </div>
          ))}
        </div>
      )}

      {role === 'owner' && proposals.length === 0 && (
        <div className="text-[13px] text-gray-400 dark:text-gray-500">
          No suggestions yet. Collaborators can propose changes here.
        </div>
      )}

      {role === 'collaborator' && myProposals.length === 0 && (
        <div className="text-[13px] text-gray-400 dark:text-gray-500">
          You haven&apos;t submitted any suggestions yet.
        </div>
      )}
    </div>
  );
}

// --- SavedTripCard ---

function SavedTripCard({ trip, onUpdate, onDelete, isSignedIn }: { trip: SavedTrip; onUpdate: (trip: SavedTrip) => void; onDelete?: () => void; isSignedIn: boolean }) {
  const { user } = useUser();
  const [activeTab, setActiveTab] = useState<'itinerary' | 'weather' | 'routes' | 'flights' | 'packing' | 'todos' | 'notes'>('itinerary');
  const [todoText, setTodoText] = useState('');
  const [proposals, setProposals] = useState<TripProposal[]>([]);
  const [proposalRole, setProposalRole] = useState<'owner' | 'collaborator' | null>(null);
  const [proposalInput, setProposalInput] = useState('');
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [proposalActionId, setProposalActionId] = useState<string | null>(null);

  // Load collaboration role and pending proposals for this trip.
  useEffect(() => {
    if (!isSignedIn) return;
    fetch(`/api/saved-trips/${trip.id}/proposals`)
      .then((r) => r.json())
      .then((data) => {
        if (data.role) setProposalRole(data.role);
        if (Array.isArray(data.proposals)) setProposals(data.proposals);
      })
      .catch(() => {});
  }, [trip.id, isSignedIn]);

  const submitProposal = async () => {
    if (!proposalInput.trim() || submittingProposal) return;
    setSubmittingProposal(true);
    try {
      const res = await fetch(`/api/saved-trips/${trip.id}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: proposalInput.trim() }),
      });
      const data = await res.json();
      if (data.proposal) {
        setProposals((prev) => [data.proposal, ...prev]);
        setProposalInput('');
      }
    } catch { /* ignore */ }
    setSubmittingProposal(false);
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
      if (data.proposal) {
        setProposals((prev) => prev.map((p) => (p.id === proposalId ? data.proposal : p)));
      }
      if (action === 'accept' && data.trip) {
        onUpdate({ ...trip, payload: data.trip.payload });
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

  const copyToClipboard = () => {
    const text = buildTripSummary(trip);
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const payload = trip.payload;

  return (
    <div className="border border-black/[0.05] dark:border-white/[0.1] rounded-[20px] bg-white dark:bg-[#2c2c2e] shadow-[0_8px_30px_rgba(0,0,0,0.08)] overflow-hidden">
      {trip.weatherAlert && (
        <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/40 px-4 py-3">
          <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 text-[13px] leading-snug text-amber-800 dark:text-amber-200">
            <span className="font-semibold">Weather alert</span>
            <p className="mt-0.5 break-words">{trip.weatherAlert}</p>
          </div>
        </div>
      )}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
            <MapPin size={16} className="text-blue-600" />
            {trip.destination || 'Trip'}
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mt-1">
            <Calendar size={14} />
            {trip.dates || 'Dates TBD'}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={copyToClipboard}
            className="text-gray-400 dark:text-gray-500 hover:text-blue-600 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Copy trip summary"
          >
            <Clipboard size={16} />
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="text-gray-400 dark:text-gray-500 hover:text-red-600 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Delete trip"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex overflow-x-auto scrollbar-hide border-b border-gray-200 dark:border-gray-700 -mx-4 px-4 md:mx-0 md:px-0">
        {(['itinerary', 'weather', 'routes', 'flights', 'packing', 'todos', 'notes'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-shrink-0 px-4 py-3 md:py-2 md:flex-1 text-[13px] font-medium capitalize whitespace-nowrap min-h-[44px] flex items-center justify-center ${
              activeTab === tab ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            }`}
          >
            {tab === 'flights' ? 'Flights & Docs' : tab}
          </button>
        ))}
      </div>

      <div className="p-3 md:p-4">
        {activeTab === 'itinerary' && (
          <div className="space-y-6">
            <ItineraryTab trip={trip} onUpdate={onUpdate} />
            <ProposalsSection
              role={proposalRole}
              proposals={proposals}
              proposalInput={proposalInput}
              setProposalInput={setProposalInput}
              submittingProposal={submittingProposal}
              onSubmit={submitProposal}
              onReview={reviewProposal}
              actionId={proposalActionId}
              userId={user?.id}
            />
          </div>
        )}

        {activeTab === 'weather' && (
          <WeatherTab trip={trip} />
        )}

        {activeTab === 'routes' && (
          <div className="space-y-3">
            {payload.transportPlan?.days && payload.transportPlan.days.length > 0 && (
              <OneStopRouteMap days={payload.transportPlan.days} />
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
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <StickyNote size={16} /> Notes
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
  if (trip.notes) summary += `Notes:\n${trip.notes}\n\n`;
  if (trip.todos.length > 0) summary += `To-dos:\n${trip.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}\n`;
  if (trip.flightInfo && trip.flightInfo.length > 0) {
    summary += `\nBookings:\n${trip.flightInfo.map((e) => `- ${e.label} (${e.airlineOrProvider}) · ${e.confirmationCode || 'no ref'}`).join('\n')}\n`;
  }
  return summary;
}

function OneStopRouteMap({ days }: { days: DayTransport[] }) {
  const [activeDay, setActiveDay] = useState(days[0]?.day || '1');
  const activeDayData = days.find((d) => d.day === activeDay) || days[0];
  if (!activeDayData) return null;
  return (
    <div className="border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-3">
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
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
      <DailyRouteMap waypoints={activeDayData.waypoints} polyline={activeDayData.polyline} />
    </div>
  );
}

export default function OneStopPanel({ isOpen, onClose, savedTrips, setSavedTrips, isSignedIn }: OneStopPanelProps) {
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
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
        className={`fixed inset-0 z-50 flex items-stretch md:items-center justify-center p-0 md:p-4 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          className={`w-full md:w-[95vw] h-[100dvh] md:h-[90vh] max-w-none md:max-w-[1000px] max-h-none md:max-h-[900px] bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl backdrop-saturate-[1.8] border-0 md:border border-black/[0.05] dark:border-white/[0.1] shadow-none md:shadow-[0_-12px_40px_rgba(0,0,0,0.16),0_20px_70px_rgba(0,0,0,0.2)] rounded-none md:rounded-[20px] flex flex-col transform transition-all duration-300 ease-out overflow-hidden ${
            isOpen ? 'translate-y-0 scale-100' : 'translate-y-4 md:translate-y-0 md:scale-95'
          }`}
        >
          {/* Mobile drag handle (hidden on desktop) */}
          <div className="md:hidden pt-2 pb-1 flex justify-center flex-shrink-0">
            <div className="w-10 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
          </div>
          <div className="px-4 md:px-5 py-2 md:py-3 border-b border-black/[0.05] dark:border-white/[0.1] flex items-center justify-between bg-white/70 dark:bg-[#1c1c1e]/70 flex-shrink-0">
            <div className="flex items-center gap-2 md:gap-4 min-w-0">
              <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100 flex-shrink-0">
                <Plane size={20} className="text-blue-600" /> <span className="hidden sm:inline">One Stop</span>
              </div>
              {isSignedIn && (
                <div className="flex gap-1 ml-2">
                  <button
                    onClick={() => setView('trips')}
                    className={`px-3 py-1 text-[13px] font-medium rounded-lg transition-colors ${
                      view === 'trips'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    Trips
                  </button>
                  <button
                    onClick={() => setView('alerts')}
                    className={`px-3 py-1 text-[13px] font-medium rounded-lg transition-colors flex items-center gap-1 ${
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
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <SavedTripCard isSignedIn={isSignedIn} trip={savedTrips[0]} onUpdate={updateTrip} onDelete={() => deleteTrip(savedTrips[0].id)} />
            </div>
          ) : (
            /* --- Trips View (multiple trips) --- */
            <>
              {/* Mobile trip selector dropdown (hidden on desktop) */}
              <div className="md:hidden px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
                <select
                  value={activeTrip?.id || ''}
                  onChange={(e) => setActiveTripId(e.target.value)}
                  className="w-full text-sm font-medium border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-400"
                >
                  {savedTrips.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {trip.destination || 'Trip'} — {trip.dates || 'Dates TBD'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1 flex overflow-hidden">
                {/* Desktop trip selector sidebar (hidden on mobile) */}
                <div className="hidden md:flex w-56 border-r border-gray-100 dark:border-gray-800 flex-col flex-shrink-0">
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

                {/* Active trip detail */}
                <div className="flex-1 overflow-y-auto p-4 md:p-6">
                  {activeTrip ? (
                    <SavedTripCard isSignedIn={isSignedIn} trip={activeTrip} onUpdate={updateTrip} onDelete={() => deleteTrip(activeTrip.id)} />
                  ) : (
                    <div className="text-center text-gray-400 dark:text-gray-500 py-16">Select a trip.</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
