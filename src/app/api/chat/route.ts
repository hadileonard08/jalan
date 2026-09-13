import { randomUUID } from 'crypto';
import { auth } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { conversationGraph, generateTitle } from '@/agents/conversation-graph';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  getOrCreateConversation,
  loadMessages,
  saveMessage,
  updateConversationMetadata,
  updateConversationTitle,
} from '@/lib/chat-db';
import type { PersistedMessage, ChatPayload, UserPreferences } from '@/lib/chat-state';

function getAuthUserId(): string | null {
  try {
    return auth().userId || null;
  } catch {
    return null;
  }
}

async function getUserPreferences(userId: string | null): Promise<UserPreferences | null> {
  if (!userId) return null;
  try {
    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      dietaryRestrictions: row.dietaryRestrictions,
      transportPreference: row.transportPreference,
      airlinePreference: row.airlinePreference,
      generalNotes: row.generalNotes,
    };
  } catch (error) {
    console.error('Failed to load user preferences:', error);
    return null;
  }
}

export async function POST(req: Request) {
  const userId = getAuthUserId();
  const cookieStore = cookies();
  let sessionId = cookieStore.get('anonymous-session-id')?.value;
  let setCookieHeader: string | undefined;

  if (!userId && !sessionId) {
    sessionId = randomUUID();
    setCookieHeader = `anonymous-session-id=${sessionId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
  }

  let body: { message?: string; conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { message, conversationId } = body;
  if (!message) {
    return new Response('Message is required', { status: 400 });
  }

  const conversation = await getOrCreateConversation({
    conversationId,
    userId: userId || null,
    sessionId: sessionId || null,
  });

  if (conversation.title === 'New trip' || !conversation.title) {
    const title = await generateTitle(message);
    await updateConversationTitle(conversation.id, title);
  }

  const history = await loadMessages(conversation.id);

  await saveMessage(conversation.id, {
    role: 'user',
    content: message,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const statusMap: Record<string, string> = {
        extract: 'Thinking...',
        clarify: 'Asking a quick question...',
        clarifyLimit: 'Finding another way...',
        answer: 'Looking that up...',
        gather: 'Planning your trip...',
        applyRefinements: 'Updating your itinerary...',
        critic: 'Double-checking...',
        enrich: 'Adding maps, transport & images...',
        respond: 'Finalizing...',
      };

      try {
        let result: any = {};
        let previewSent = false;
        // Marks the persisted message so the next turn can count how many
        // clarifying questions in a row we've asked (loop guard).
        let askedClarifyingQuestion = false;

        const streamUserPreferences = await getUserPreferences(userId);

        // thread_id ties the run to this conversation so the checkpointer can
        // pause at END and resume with the same state on the user's next reply.
        const graphStream = await conversationGraph.stream(
          { userMessage: message, history, userPreferences: streamUserPreferences },
          { streamMode: 'updates', configurable: { thread_id: conversation.id } }
        );

        for await (const chunk of graphStream) {
          for (const [nodeName, update] of Object.entries(chunk)) {
            if (nodeName in statusMap) {
              emit({ type: 'status', message: statusMap[nodeName] });
            }
            if (nodeName === 'clarify') {
              askedClarifyingQuestion = true;
            }
            if (typeof update === 'object' && update !== null) {
              result = { ...result, ...update };
              const nodeUpdate = update as Record<string, unknown>;
              if (nodeName === 'critic' && nodeUpdate.isApproved === true && result.itinerary) {
                const destination = result.entities?.destination || 'Your Trip';
                const startDate = result.entities?.startDate;
                const endDate = result.entities?.endDate;
                const dateStr = startDate
                  ? `${startDate}${endDate ? ` - ${endDate}` : ''}`
                  : result.entities?.datesGeneral || 'upcoming dates';
                const packingSection = result.packingTips ? `\n---\n\n## 🧳 Packing Tips\n\n${result.packingTips}` : '';
                const previewResponse = `# ${destination} Itinerary — ${dateStr}\n\n${result.itinerary}${packingSection}`;
                emit({ type: 'preview', content: previewResponse });
                previewSent = true;
              }
            }
          }
        }

        const finalResponse = (result.finalResponse || result.itinerary || 'Here is what I found.') as string;
        if (previewSent) {
          emit({ type: 'final_content', content: finalResponse });
        } else {
          const words = finalResponse.split(/(\s+)/);
          for (const word of words) {
            emit({ type: 'content', chunk: word });
          }
        }

        const payload: ChatPayload = {
          entities: result.entities,
          weather: result.weather,
          news: result.news || undefined,
          deals: result.deals,
          images: result.images,
          itinerary: result.itinerary,
          routeLinks: result.routeLinks,
          transportPlan: result.transportPlan || undefined,
          packingTips: result.packingTips,
          feedback: result.criticFeedback?.length ? result.criticFeedback : undefined,
          clarification: askedClarifyingQuestion || undefined,
        };

        emit({ type: 'done', payload, conversationId: conversation.id });

        // Persist the assistant message and metadata after streaming is done.
        // These are awaited so the save completes before the serverless
        // function exits. Wrapped in their own try/catch so a DB failure
        // (e.g. transient FK/connection issue) doesn't emit an error event
        // to the client on top of a perfectly good response.
        try {
          await updateConversationMetadata(conversation.id, result.entities || {});
          await saveMessage(conversation.id, {
            role: 'assistant',
            content: finalResponse,
            payload,
          });
        } catch (persistError) {
          console.error('Failed to persist assistant message:', persistError);
        }
      } catch (error) {
        console.error('Chat error:', error);
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : 'Something went wrong',
        });
      } finally {
        controller.close();
      }
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  if (setCookieHeader) {
    headers['Set-Cookie'] = setCookieHeader;
  }

  return new Response(stream, { headers });
}
