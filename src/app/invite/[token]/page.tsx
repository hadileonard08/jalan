'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Plane, MapPin, Calendar, Check, Loader2 } from 'lucide-react';
import { useUser, SignInButtonWrapper } from '@/components/AuthProvider';
import { rememberPendingInvite, clearPendingInvite } from '@/lib/pending-invite';

interface InviteInfo {
  invite: { role: 'owner' | 'collaborator'; roleLabel: string; expiresAt: string | null };
  trip: { id: string; destination: string; dates: string };
  alreadyMember: boolean;
}

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const token = typeof params?.token === 'string' ? params.token : '';
  const { isLoaded, isSignedIn } = useUser();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  // Joining is attempted automatically, once, as soon as the visitor is signed
  // in. Opening an invite link is the intent — making people hunt for a second
  // button after signing up is how they end up with an empty One Stop.
  const autoJoinedRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    setLoadError('');
    fetch(`/api/invites/${token}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Invite not found');
        setInfo(data);
        setJoined(!!data.alreadyMember);
        // Survive a sign-in redirect that doesn't come back to this URL.
        if (!data.alreadyMember) rememberPendingInvite(token);
      })
      .catch((err) => setLoadError(err.message || 'Invite not found'));
  }, [token, isSignedIn]);

  const join = useCallback(async () => {
    setJoining(true);
    setJoinError('');
    try {
      const res = await fetch(`/api/invites/${token}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to join');
      setJoined(true);
      clearPendingInvite();
      router.refresh();
    } catch (err: any) {
      setJoinError(err.message || 'Failed to join the trip');
      // Allow another attempt if it failed.
      autoJoinedRef.current = false;
    }
    setJoining(false);
  }, [token, router]);

  useEffect(() => {
    if (!info || !isLoaded || !isSignedIn) return;
    if (joined || info.alreadyMember) return;
    if (autoJoinedRef.current) return;
    autoJoinedRef.current = true;
    void join();
  }, [info, isLoaded, isSignedIn, joined, join]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#1c1c1e] p-4">
      <div className="w-full max-w-md rounded-[20px] border border-black/[0.05] dark:border-white/[0.1] bg-white dark:bg-[#2c2c2e] shadow-[0_8px_30px_rgba(0,0,0,0.08)] p-6">
        <div className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100 mb-5">
          <Plane size={20} className="text-blue-600" /> Jalan
        </div>

        {loadError ? (
          <div className="text-center py-6">
            <p className="text-sm text-gray-600 dark:text-gray-300">{loadError}</p>
            <a href="/" className="inline-block mt-4 text-sm text-blue-600 hover:underline">
              Back to Jalan
            </a>
          </div>
        ) : !info ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Trip invitation
              </div>
              <div className="flex items-center gap-2 mt-2 font-semibold text-gray-900 dark:text-gray-100">
                <MapPin size={16} className="text-blue-600" />
                {info.trip.destination || 'Trip'}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mt-1">
                <Calendar size={14} />
                {info.trip.dates}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
              <p className="text-[12px] text-gray-500 dark:text-gray-400">
                You&apos;ll join as a <span className="font-semibold text-gray-700 dark:text-gray-300">Follower</span>.
                Followers can comment and suggest changes; the Master Planner approves them.
              </p>
            </div>

            {joined ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
                  <Check size={16} /> You&apos;re on this trip.
                </div>
                <p className="text-[12px] text-gray-500 dark:text-gray-400">
                  It&apos;s now in your One Stop panel — open Jalan and pick it from the trip list.
                </p>
                <button
                  onClick={() => router.push('/')}
                  className="w-full bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700"
                >
                  Go to Jalan
                </button>
              </div>
            ) : !isLoaded ? (
              <div className="flex items-center justify-center py-2 text-gray-400">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : !isSignedIn ? (
              <div className="space-y-2">
                <p className="text-[13px] text-gray-500 dark:text-gray-400">
                  Sign in or sign up and you&apos;ll be added to the trip automatically.
                </p>
                <SignInButtonWrapper mode="modal">
                  <button className="w-full bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700">
                    Sign in to join
                  </button>
                </SignInButtonWrapper>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  {joining ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {joining ? 'Adding you to the trip…' : 'Ready to join'}
                </div>
                {joinError && (
                  <>
                    <p className="text-[12px] text-red-600 dark:text-red-400">{joinError}</p>
                    <button
                      onClick={join}
                      disabled={joining}
                      className="w-full bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      Try again
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
