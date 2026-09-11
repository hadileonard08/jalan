'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { ClerkProvider, useUser as useClerkUser, SignInButton, UserButton } from '@clerk/nextjs';

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: any;
}

const AuthContext = createContext<AuthState>({ isLoaded: true, isSignedIn: false, user: null });

const clerkKey = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY : undefined;
const clerkConfigured = !!clerkKey && !clerkKey.startsWith('pk_test_') && !clerkKey.startsWith('pk_test_...');

const clerkOptions = clerkConfigured
  ? {
      clerkJSUrl: '/__clerk/npm/@clerk/clerk-js@5/dist/clerk.browser.js',
      proxyUrl: '/__clerk',
    }
  : undefined;

function ClerkUserProvider({ children }: { children: ReactNode }) {
  const clerk = useClerkUser();
  return (
    <AuthContext.Provider
      value={{
        isLoaded: clerk.isLoaded,
        isSignedIn: clerk.isSignedIn ?? false,
        user: clerk.user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (clerkConfigured) {
    return (
      <ClerkProvider {...clerkOptions}>
        <ClerkUserProvider>{children}</ClerkUserProvider>
      </ClerkProvider>
    );
  }
  return (
    <AuthContext.Provider value={{ isLoaded: true, isSignedIn: false, user: null }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useUser() {
  return useContext(AuthContext);
}

export function SignInButtonWrapper({ children, ...props }: { children: ReactNode; [key: string]: any }) {
  if (!clerkConfigured) return null;
  return <SignInButton {...props}>{children}</SignInButton>;
}

export function UserButtonWrapper(props: any) {
  if (!clerkConfigured) return null;
  return <UserButton {...props} />;
}
