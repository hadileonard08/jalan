// Resolves Clerk user IDs to human-readable profiles via the Clerk Backend API.
// Falls back gracefully (no name) when Clerk isn't configured or a lookup fails.

export interface ClerkUserProfile {
  id: string;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { profile: ClerkUserProfile; expiresAt: number }>();

function displayName(user: any): string | null {
  const full = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (user?.username) return user.username;
  const primary = user?.email_addresses?.find((e: any) => e.id === user?.primary_email_address_id);
  const email = primary?.email_address || user?.email_addresses?.[0]?.email_address;
  return email || null;
}

function primaryEmail(user: any): string | null {
  const primary = user?.email_addresses?.find((e: any) => e.id === user?.primary_email_address_id);
  return primary?.email_address || user?.email_addresses?.[0]?.email_address || null;
}

export async function resolveClerkUsers(userIds: string[]): Promise<Record<string, ClerkUserProfile>> {
  const result: Record<string, ClerkUserProfile> = {};
  const missing: string[] = [];

  for (const id of userIds) {
    const hit = cache.get(id);
    if (hit && hit.expiresAt > Date.now()) result[id] = hit.profile;
    else missing.push(id);
  }

  const secret = process.env.CLERK_SECRET_KEY;
  if (missing.length === 0 || !secret) return result;

  try {
    const params = new URLSearchParams({ limit: String(Math.min(missing.length, 100)) });
    for (const id of missing) params.append('user_id[]', id);

    const res = await fetch(`https://api.clerk.com/v1/users?${params.toString()}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return result;

    const users = await res.json();
    if (!Array.isArray(users)) return result;

    for (const user of users) {
      if (!user?.id) continue;
      const profile: ClerkUserProfile = {
        id: user.id,
        name: displayName(user),
        email: primaryEmail(user),
        imageUrl: user.image_url || null,
      };
      result[user.id] = profile;
      cache.set(user.id, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  } catch {
    // Network failure or timeout — callers fall back to the raw ID.
  }

  return result;
}
