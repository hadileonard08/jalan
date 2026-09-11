'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, User, Loader2 } from 'lucide-react';

interface UserPreferences {
  dietaryRestrictions?: string | null;
  transportPreference?: string | null;
  airlinePreference?: string | null;
  generalNotes?: string | null;
}

interface TravelerProfileModalProps {
  open: boolean;
  onClose: () => void;
}

export default function TravelerProfileModal({ open, onClose }: TravelerProfileModalProps) {
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/user-preferences');
      const data = await res.json();
      if (data.preferences) {
        setPreferences({
          dietaryRestrictions: data.preferences.dietaryRestrictions || '',
          transportPreference: data.preferences.transportPreference || '',
          airlinePreference: data.preferences.airlinePreference || '',
          generalNotes: data.preferences.generalNotes || '',
        });
      } else {
        setPreferences({});
      }
    } catch (err) {
      setError('Failed to load preferences.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/user-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences),
      });
      if (!res.ok) throw new Error('Save failed');
      onClose();
    } catch (err) {
      setError('Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  };

  const update = (field: keyof UserPreferences, value: string) => {
    setPreferences((p) => ({ ...p, [field]: value }));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-100 dark:border-gray-800">
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <User size={18} className="text-gray-500" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Traveler Profile</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-gray-400" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-4 space-y-4">
            {error && (
              <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/30 px-3 py-2 rounded-lg">{error}</div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Dietary restrictions</label>
              <input
                type="text"
                value={preferences.dietaryRestrictions || ''}
                onChange={(e) => update('dietaryRestrictions', e.target.value)}
                placeholder="e.g. vegetarian, halal, no nuts"
                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Transport preference</label>
              <select
                value={preferences.transportPreference || ''}
                onChange={(e) => update('transportPreference', e.target.value)}
                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select —</option>
                <option value="Transit">Transit</option>
                <option value="Ride-share">Ride-share</option>
                <option value="Walk">Walk</option>
                <option value="Rental car">Rental car</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Airline alliance preference</label>
              <select
                value={preferences.airlinePreference || ''}
                onChange={(e) => update('airlinePreference', e.target.value)}
                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select —</option>
                <option value="Oneworld">Oneworld</option>
                <option value="Star Alliance">Star Alliance</option>
                <option value="SkyTeam">SkyTeam</option>
                <option value="No preference">No preference</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">General notes</label>
              <textarea
                value={preferences.generalNotes || ''}
                onChange={(e) => update('generalNotes', e.target.value)}
                placeholder="Any other travel preferences..."
                rows={3}
                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                Save
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
