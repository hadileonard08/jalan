/**
 * Test: remembering an invite across a sign-in redirect.
 *
 * Signing in with Google can land the user somewhere other than the invite URL,
 * and the token only exists in that URL — so the join silently never happens.
 * These helpers park the token and let the app finish the join afterwards.
 *
 * Usage:
 *   npx tsx scripts/test-pending-invite.ts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// Minimal localStorage stub so the module can be exercised outside a browser.
// Installed before the module is imported, since it reads storage lazily.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

async function main() {
  const { rememberPendingInvite, peekPendingInvite, clearPendingInvite } =
    await import('../src/lib/pending-invite');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TEST: pending invite across sign-in');
  console.log('═══════════════════════════════════════════════════════════\n');

  check('nothing pending initially', peekPendingInvite(), null);
  rememberPendingInvite('tok-abc');
  check('remembers the token', peekPendingInvite(), 'tok-abc');
  check('peek does not consume it', peekPendingInvite(), 'tok-abc');

  rememberPendingInvite('tok-second');
  check('a newer invite replaces the old one', peekPendingInvite(), 'tok-second');

  clearPendingInvite();
  check('cleared after a successful join', peekPendingInvite(), null);

  rememberPendingInvite('');
  check('an empty token is ignored', peekPendingInvite(), null);

  console.log('\nStorage unavailable (private mode / SSR):');
  (globalThis as any).localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  let threw = false;
  try {
    rememberPendingInvite('tok');
    clearPendingInvite();
  } catch { threw = true; }
  check('never throws when storage is blocked', threw, false);
  check('returns null when storage is blocked', peekPendingInvite(), null);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '  RESULT: ✅ ALL TESTS PASSED' : `  RESULT: ❌ ${failures} FAILED`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failures > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

// Marks this file as a module — without it the top-level `main` collides with
// the one in smoke-test.ts, which TS reports as a duplicate implementation.
export {};
