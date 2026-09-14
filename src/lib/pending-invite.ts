// Remembers an invite across a sign-in redirect.
//
// Signing in with Google sends the browser to Google and back. Clerk normally
// returns to the page you started from, but if it lands anywhere else (the chat
// home, say) the invite token — which only exists in the URL — is gone and the
// join never happens. Parking it here lets the app finish the join once a session
// exists, wherever the user lands.

const KEY = 'jalan-pending-invite';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function rememberPendingInvite(token: string): void {
  if (!token) return;
  try { store()?.setItem(KEY, token); } catch { /* private mode */ }
}

export function peekPendingInvite(): string | null {
  try { return store()?.getItem(KEY) || null; } catch { return null; }
}

export function clearPendingInvite(): void {
  try { store()?.removeItem(KEY); } catch { /* ignore */ }
}
