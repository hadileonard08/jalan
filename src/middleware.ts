import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const clerkConfigured =
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
  !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith('pk_test_') &&
  !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith('pk_test_...');

export default clerkConfigured
  ? clerkMiddleware(
      async () => NextResponse.next(),
      {
        proxyUrl: '/__clerk',
        domain: 'jalan-ai.vercel.app',
      },
    )
  : async () => NextResponse.next();

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    '/__clerk/:path*',
  ],
};
