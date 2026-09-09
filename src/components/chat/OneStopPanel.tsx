'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Trash2, CheckSquare, Square, Plane, Clipboard, StickyNote, MapPin, Calendar, Map, Bell } from 'lucide-react';
import type { SavedTrip, ChatPayload } from '@/lib/chat-state';
import { getAirlineBookingUrl } from '@/lib/airline-booking';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

function SavedTripCard({ trip, onUpdate, onDelete }: { trip: SavedTrip; onUpdate: (trip: SavedTrip) => void; onDelete?: () => void }) {
  const [activeTab, setActiveTab] = useState<'deals' | 'itinerary' | 'routes' | 'packing' | 'todos' | 'notes'>('deals');
  const [todoText, setTodoText] = useState('');

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

      <div className="flex overflow-x-auto border-b border-gray-200 dark:border-gray-700">
        {(['deals', 'itinerary', 'routes', 'packing', 'todos', 'notes'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-3 py-2 text-[13px] font-medium capitalize whitespace-nowrap ${
              activeTab === tab ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="p-4">
        {activeTab === 'deals' && (
          <div className="space-y-2">
            {payload.deals && payload.deals.length > 0 ? (
              payload.deals.slice(0, 5).map((deal, i) => {
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
                    className="block border border-black/[0.05] dark:border-white/[0.1] rounded-2xl p-4 hover:border-blue-500/40 hover:shadow-md active:scale-95 transition-all duration-200 ease-out no-underline"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {deal.originCode} → {deal.destinationCode}
                      </div>
                      <div className="text-blue-600 dark:text-blue-400 font-semibold">
                        {Number(deal.pointsRequired).toLocaleString()} pts
                      </div>
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {deal.airline} · {deal.cabin} · {formatDate(deal.departureDate)}
                    </div>
                    <div className="text-[13px] text-gray-400 dark:text-gray-500 mt-1">
                      {formatDuration(deal.duration)}
                      {deal.duration && deal.stops !== null && deal.stops !== undefined ? ' · ' : ''}
                      {formatStops(deal.stops)}
                    </div>
                    {deal.taxesAndFees ? (
                      <div className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">+ ${Number(deal.taxesAndFees).toFixed(2)} taxes</div>
                    ) : null}
                  </a>
                );
              })
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">No deals saved.</div>
            )}
          </div>
        )}

        {activeTab === 'itinerary' && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
            {payload.itinerary ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ src, alt }) => (
                    <figure className="my-3">
                      {src && <img src={src} alt={alt || ''} className="rounded-xl shadow-md w-full" loading="lazy" />}
                      {alt && <figcaption className="text-[13px] text-gray-400 dark:text-gray-500 text-center mt-1">{alt}</figcaption>}
                    </figure>
                  ),
                  h1: ({ children }) => <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 mt-2 mb-1">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-base font-bold text-gray-900 dark:text-gray-100 mt-3 mb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-2 mb-1">{children}</h3>,
                  strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                  ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-0.5">{children}</ol>,
                }}
              >
                {payload.itinerary}
              </ReactMarkdown>
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">No itinerary saved.</div>
            )}
          </div>
        )}

        {activeTab === 'routes' && (
          <div className="space-y-2">
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
                className="flex-1 text-sm border border-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              <button
                onClick={addTodo}
                className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <Plus size={16} />
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
  if (p.deals && p.deals.length > 0) {
    summary += 'Deals:\n';
    p.deals.forEach((d) => {
      summary += `- ${d.originCode} → ${d.destinationCode} · ${d.airline} · ${d.pointsRequired} pts\n`;
    });
    summary += '\n';
  }
  if (p.itinerary) summary += `Itinerary:\n${p.itinerary}\n\n`;
  if (p.routeLinks && p.routeLinks.length > 0) {
    summary += `Routes:\n${p.routeLinks.map((r) => `- Day ${r.day}: ${r.url}`).join('\n')}\n\n`;
  }
  if (p.packingTips) summary += `Packing:\n${p.packingTips}\n\n`;
  if (trip.notes) summary += `Notes:\n${trip.notes}\n\n`;
  if (trip.todos.length > 0) summary += `To-dos:\n${trip.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}\n`;
  return summary;
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
        body: JSON.stringify({ todos: updated.todos, notes: updated.notes }),
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
        className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          className={`w-full sm:w-[95vw] h-[92dvh] sm:h-[90vh] max-w-[1000px] max-h-[900px] bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl backdrop-saturate-[1.8] border border-black/[0.05] dark:border-white/[0.1] shadow-[0_-12px_40px_rgba(0,0,0,0.16),0_20px_70px_rgba(0,0,0,0.2)] rounded-t-[24px] sm:rounded-[20px] flex flex-col transform transition-all duration-300 ease-out overflow-hidden ${
            isOpen ? 'translate-y-0 scale-100' : 'translate-y-6 sm:translate-y-0 sm:scale-95'
          }`}
        >
          <div className="sm:hidden pt-2.5 flex justify-center">
            <div className="w-10 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
          </div>
          <div className="px-5 py-3 border-b border-black/[0.05] dark:border-white/[0.1] flex items-center justify-between bg-white/70 dark:bg-[#1c1c1e]/70">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
                <Plane size={22} className="text-blue-600" /> One Stop
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
            <div className="flex-1 overflow-y-auto p-6">
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
                    <div className="grid grid-cols-2 gap-3 mb-3">
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
                <p className="text-sm mt-1">Save a deal, itinerary, or packing list from any assistant message.</p>
              </div>
            </div>
          ) : savedTrips.length === 1 ? (
            /* --- Trips View (single trip) --- */
            <div className="flex-1 overflow-y-auto p-6">
              <SavedTripCard trip={savedTrips[0]} onUpdate={updateTrip} onDelete={() => deleteTrip(savedTrips[0].id)} />
            </div>
          ) : (
            /* --- Trips View (multiple trips) --- */
            <div className="flex-1 flex overflow-hidden">
              {/* Trip selector sidebar */}
              <div className="w-56 border-r border-gray-100 dark:border-gray-800 flex flex-col flex-shrink-0">
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
              <div className="flex-1 overflow-y-auto p-6">
                {activeTrip ? (
                  <SavedTripCard trip={activeTrip} onUpdate={updateTrip} onDelete={() => deleteTrip(activeTrip.id)} />
                ) : (
                  <div className="text-center text-gray-400 dark:text-gray-500 py-16">Select a trip from the left.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
