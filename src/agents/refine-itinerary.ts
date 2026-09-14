import { getChatModel } from '../lib/ai-provider';
import { ItineraryPatchSchema, type ItineraryPatch, type ItineraryEdit } from '../lib/chat-state';
import type { PersistedMessage } from '../lib/chat-state';

// ---------------------------------------------------------------------------
// mergeItineraryPatch — deterministic reducer
// ---------------------------------------------------------------------------
// Applies a JSON patch (array of edits) to an existing itinerary markdown
// string. This is pure: it does not call any LLM or external service.
// Days not mentioned in the patch are returned byte-for-byte identical.

export function mergeItineraryPatch(currentItinerary: string, patch: ItineraryPatch): string {
  if (!currentItinerary || !patch.edits || patch.edits.length === 0) return currentItinerary;

  // Split into day blocks. Each block starts at a "## Day N" heading.
  // We preserve the text before the first day heading (e.g. intro paragraph).
  // Use the 'm' flag so ^ matches line starts, preventing the regex from
  // splitting inside "## Day 1" at both # positions.
  const daySplit = currentItinerary.split(/(?=^#+\s+Day\s+\d+)/im);
  const preamble = daySplit[0];
  const dayBlocks = daySplit.slice(1);

  for (const edit of patch.edits) {
    const dayIndex = edit.dayNumber - 1; // 1-indexed → 0-indexed
    if (dayIndex < 0 || dayIndex >= dayBlocks.length) continue;

    dayBlocks[dayIndex] = applyEditToDay(dayBlocks[dayIndex], edit);
  }

  return preamble + dayBlocks.join('');
}

// ---------------------------------------------------------------------------
// applyEditToDay — applies a single edit to a day block
// ---------------------------------------------------------------------------

function applyEditToDay(dayBlock: string, edit: ItineraryEdit): string {
  switch (edit.action) {
    case 'replace_stop':
      return replaceStop(dayBlock, edit);
    case 'add_stop':
      return addStop(dayBlock, edit);
    case 'remove_stop':
      return removeStop(dayBlock, edit);
    case 'update_note':
      return updateNote(dayBlock, edit);
    default:
      return dayBlock;
  }
}

// Escape regex special characters in a string.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// All bold spans on a line. Itinerary days often pack several stops into one
// sentence ("visit the **Space Needle**, dinner at **The Pink Door**"), so we
// must check every span, not just the first one.
function boldSpans(line: string): string[] {
  return Array.from(line.matchAll(/\*\*(.+?)\*\*/g)).map((m) => m[1]);
}

// Does a bolded span refer to the requested stop? Case-insensitive, fuzzy.
function spanMatches(bold: string, target: string): boolean {
  const b = bold.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (!b || !t) return false;
  if (b === t) return true;
  if (b.includes(t) || t.includes(b)) return true;

  const boldWords = b.split(/\s+/).filter(Boolean);
  const targetWords = t.split(/\s+/).filter(Boolean);
  const overlap = targetWords.filter((w) => boldWords.includes(w)).length;
  return overlap >= 2 || (targetWords.length > 0 && overlap / targetWords.length >= 0.5);
}

// Find a line containing a bold stop name (case-insensitive and fuzzy).
// Returns the line index or -1.
function findStopLine(lines: string[], stopName: string): number {
  const target = stopName.toLowerCase().trim();
  const words = target.split(/\s+/).filter(Boolean);
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const spans = boldSpans(lines[i]);
    for (const span of spans) {
      const bold = span.toLowerCase().trim();

      // Exact match — highest priority
      if (bold === target) return i;

      // Substring containment in either direction
      if (bold.includes(target) || target.includes(bold)) return i;

      // Score by overlapping words
      const boldWords = bold.split(/\s+/).filter(Boolean);
      const overlap = words.filter((w) => boldWords.includes(w)).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        bestIdx = i;
      }
    }
  }

  // Accept the best partial match if it shares at least 2 words or ≥50% of the target words
  if (
    bestIdx >= 0 &&
    (bestScore >= 2 || (words.length > 0 && bestScore / words.length >= 0.5))
  ) {
    return bestIdx;
  }
  return -1;
}

// Split a line into sentences, keeping trailing whitespace with each sentence.
function splitSentences(line: string): string[] {
  return line.match(/[^.!?]+[.!?]*\s*/g) || [line];
}

// Swap a stop's name and (optionally) the sentence describing it, without
// destroying other stops that share the same line.
function editStopInLine(line: string, target: string, newName: string, newDesc?: string): string {
  const spans = Array.from(line.matchAll(/\*\*(.+?)\*\*/g));
  const hit = spans.find((m) => spanMatches(m[1], target));
  if (!hit) return line;

  const isBullet = /^\s*[-*]\s/.test(line);
  const isOnlyBold = spans.length === 1;

  // A dedicated bullet line like "- **Space Needle** — notes" can be rewritten
  // wholesale, since nothing else lives on it.
  if (isBullet && isOnlyBold) {
    const prefix = line.match(/^(\s*[-*]\s*)/)?.[1] || '- ';
    return newDesc ? `${prefix}**${newName}** — ${newDesc}` : line.replace(hit[0], `**${newName}**`);
  }

  // Otherwise swap just this stop's name and leave neighbouring stops intact.
  let updated = line.replace(hit[0], `**${newName}**`);
  if (!newDesc) return updated;

  // Replace the sentence that introduced the stop so it stops describing the
  // old one, then drop any follow-up sentences that only elaborated on it.
  const sentences = splitSentences(updated);
  const sentenceIdx = sentences.findIndex((s) => s.includes(`**${newName}**`));
  if (sentenceIdx === -1) return updated;

  const lead = /^\s*/.exec(sentences[sentenceIdx])?.[0] || '';
  sentences[sentenceIdx] = `${lead}Visit **${newName}** — ${newDesc} `;

  let dropped = 0;
  while (
    dropped < 2 &&
    sentenceIdx + 1 + dropped < sentences.length &&
    boldSpans(sentences[sentenceIdx + 1 + dropped]).length === 0
  ) {
    dropped++;
  }
  sentences.splice(sentenceIdx + 1, dropped);

  return sentences.join('');
}

// Replace a stop's name and/or description.
function replaceStop(dayBlock: string, edit: ItineraryEdit): string {
  if (!edit.targetStopName) return dayBlock;
  const lines = dayBlock.split('\n');
  const idx = findStopLine(lines, edit.targetStopName);
  if (idx === -1) return dayBlock;

  const newName = edit.newDetails?.name || edit.targetStopName;
  lines[idx] = editStopInLine(lines[idx], edit.targetStopName, newName, edit.newDetails?.description);

  // Also update any associated image placeholder
  if (edit.newDetails?.name) {
    for (let i = 0; i < lines.length; i++) {
      const imgMatch = lines[i].match(/!\[IMAGE:\s*(.+?)\s*\]/i);
      if (imgMatch && imgMatch[1].toLowerCase().trim() === edit.targetStopName.toLowerCase().trim()) {
        lines[i] = lines[i].replace(
          new RegExp(`!\\[IMAGE:\\s*${escapeRegex(edit.targetStopName)}\\s*\\]`, 'i'),
          `![IMAGE: ${newName}]`
        );
      }
    }
  }

  return lines.join('\n');
}

// Add a new stop under a time slot.
function addStop(dayBlock: string, edit: ItineraryEdit): string {
  if (!edit.newDetails?.name) return dayBlock;

  const lines = dayBlock.split('\n');
  const slot = (edit.newDetails.time_slot || 'morning').toLowerCase();
  const slotPattern = new RegExp(
    `\\**[🌅🌞🌙]?\\s*${slot}[sS]*[:：]?\\**\\s*$`,
    'i'
  );

  // Find the time slot heading
  let slotIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (slotPattern.test(lines[i].trim())) {
      slotIdx = i;
      break;
    }
  }

  const newLine = `- **${edit.newDetails.name}**${edit.newDetails.description ? ` — ${edit.newDetails.description}` : ''}`;

  if (slotIdx === -1) {
    // Time slot doesn't exist — add the heading and the stop before the next
    // time slot or end of day.
    const slotEmoji = slot === 'morning' ? '🌅' : slot === 'afternoon' ? '🌞' : '🌙';
    const newSlotHeading = `\n**${slotEmoji} ${slot.charAt(0).toUpperCase() + slot.slice(1)}:**\n`;
    // Insert before the next time slot or at the end
    let insertAt = lines.length;
    const slotOrder = ['morning', 'afternoon', 'evening'];
    const currentSlotIdx = slotOrder.indexOf(slot);
    for (let i = 0; i < lines.length; i++) {
      for (let s = currentSlotIdx + 1; s < slotOrder.length; s++) {
        if (new RegExp(`\\**[🌅🌞🌙]?\\s*${slotOrder[s]}`, 'i').test(lines[i].trim())) {
          insertAt = i;
          break;
        }
      }
      if (insertAt !== lines.length) break;
    }
    lines.splice(insertAt, 0, newSlotHeading + newLine);
  } else {
    // Find the last stop under this time slot (before the next heading or blank line block)
    let insertAt = slotIdx + 1;
    while (insertAt < lines.length) {
      const nextLine = lines[insertAt].trim();
      if (nextLine === '' || /^\*\*.*[=:：]\*\*\s*$/.test(nextLine) || /^#+\s/.test(nextLine) || /^!\[IMAGE:/.test(nextLine)) {
        break;
      }
      insertAt++;
    }
    lines.splice(insertAt, 0, newLine);
  }

  return lines.join('\n');
}

// Remove a stop by name (and its associated image placeholder).
function removeStop(dayBlock: string, edit: ItineraryEdit): string {
  if (!edit.targetStopName) return dayBlock;

  const lines = dayBlock.split('\n');
  const idx = findStopLine(lines, edit.targetStopName);
  if (idx === -1) return dayBlock;

  // Remove the stop line
  lines.splice(idx, 1);

  // Also remove any associated image placeholder
  for (let i = 0; i < lines.length; i++) {
    const imgMatch = lines[i].match(/!\[IMAGE:\s*(.+?)\s*\]/i);
    if (imgMatch && imgMatch[1].toLowerCase().trim() === edit.targetStopName.toLowerCase().trim()) {
      lines.splice(i, 1);
      break;
    }
  }

  return lines.join('\n');
}

// Update the description/note of a stop without changing its name.
function updateNote(dayBlock: string, edit: ItineraryEdit): string {
  if (!edit.targetStopName || !edit.newDetails?.description) return dayBlock;

  const lines = dayBlock.split('\n');
  const idx = findStopLine(lines, edit.targetStopName);
  if (idx === -1) return dayBlock;

  // Keep the stop's existing name (whatever bold span actually matched).
  const hit = boldSpans(lines[idx]).find((span) => spanMatches(span, edit.targetStopName!));
  lines[idx] = editStopInLine(
    lines[idx],
    edit.targetStopName,
    hit || edit.targetStopName,
    edit.newDetails.description
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// extractExistingItinerary — pull the most recent itinerary from history
// ---------------------------------------------------------------------------

export function extractExistingItinerary(history: PersistedMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'assistant' && msg.payload?.itinerary) {
      return msg.payload.itinerary;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// generateItineraryPatch — generate a JSON patch without applying it
// ---------------------------------------------------------------------------

export async function generateItineraryPatch(
  existingItinerary: string,
  destination: string,
  userQuery: string
): Promise<ItineraryPatch> {
  if (!existingItinerary) {
    throw new Error('No existing itinerary to refine.');
  }

  const prompt = `You are a surgical editor for travel itineraries.

Current itinerary for ${destination}:

${existingItinerary}

The user's request: "${userQuery}"

Instructions:
- You are a surgical editor. Look at the current itinerary and the user's request.
- Output ONLY the specific edits needed to satisfy the request.
- Do NOT rewrite the rest of the itinerary.
- Use dayNumber (1-indexed) to target the correct day.
- For replace_stop: provide targetStopName (the EXACT bolded stop name as it appears in the itinerary, or a short recognizable subset/keyword from it) and newDetails with the new name and/or description. The new name should be a real, well-known alternative for the destination.
- For remove_stop: provide targetStopName of the stop to remove. If the user wants to drop a stop because they don't like it (e.g. "I don't drink beer", "replace the brewery"), use remove_stop and then optionally add_stop a replacement.
- For add_stop: provide newDetails with name, description, and time_slot ("morning", "afternoon", or "evening").
- Time-slot rules — a venue must be open when you place it:
  - Morning (09:00–12:00) / Afternoon (13:00–17:00): museums, galleries, gardens, botanical gardens, arboretums, zoos, aquariums, libraries, palaces, shrines, temples, and anything with standard daytime hours.
  - Evening (18:00–22:00): dinner, night markets, rooftop bars, sunset viewpoints, illuminated landmarks, nightlife, and evening walks.
  - NEVER place a museum, gallery, garden, botanical garden, zoo, aquarium, library, or palace in the Evening — they close in the late afternoon.
  - If the user asks for the Evening but the venue closes earlier, place it in the Afternoon and say so in the description.
- For update_note: provide targetStopName and newDetails.description with the updated description.
- If the user's request cannot be matched to a specific stop, use remove_stop for the closest bolded landmark and add_stop to insert a suitable replacement.
- If the user is giving a dietary or preference constraint (e.g. "I don't drink beer", "no pork", "vegetarian"), remove the offending stop and add an appropriate alternative.
- If the user's request doesn't map to any specific edit and is more of a vague style change, return an empty edits array.
- Match stop names using the exact bolded text in the itinerary. Substrings and common keywords are acceptable (e.g. "Oktoberfest" can match a bolded stop like "Oktoberfest at Bavarian Bierhaus" or "Bavarian Bierhaus").`;

  const model = getChatModel(0.2, 'gemini-3.5-flash-lite');
  if (!model) throw new Error('AI provider not configured for refine');

  const structured = (model as any).withStructuredOutput(ItineraryPatchSchema);
  const patch = await structured.invoke(prompt);
  return ItineraryPatchSchema.parse(patch);
}

// ---------------------------------------------------------------------------
// applyRefinements — LangGraph node for the refine intent
// ---------------------------------------------------------------------------

export async function applyRefinements(
  state: {
    userQuery: string;
    userMessage: string;
    history: PersistedMessage[];
    draftItinerary: string;
    currentItinerary: string;
    previousItineraries: string[];
    entities: { destination?: string; intent?: string; refinementInstructions?: string };
  }
): Promise<{ draftItinerary: string; itinerary: string; currentItinerary: string; previousItineraries: string[] }> {
  // 1. Get the existing itinerary — prefer currentItinerary, then draftItinerary, then search history.
  const existingItinerary =
    state.currentItinerary || state.draftItinerary || extractExistingItinerary(state.history);

  if (!existingItinerary) {
    // No existing itinerary to refine — this shouldn't happen because the
    // router checks for destination, but guard against it.
    throw new Error('Refine intent received but no existing itinerary found in history.');
  }

  // 2. Generate and validate the patch.
  const destination = state.entities.destination || 'the destination';
  const userQuery = state.entities.refinementInstructions || state.userMessage || state.userQuery;
  const validated = await generateItineraryPatch(existingItinerary, destination, userQuery);

  // 3. Apply the patch deterministically.
  const newItinerary = mergeItineraryPatch(existingItinerary, validated);

  // 6. Preserve the unpatched version and set the new one as current.
  const previousItineraries = [...state.previousItineraries];
  if (existingItinerary && !previousItineraries.includes(existingItinerary)) {
    previousItineraries.push(existingItinerary);
  }

  return {
    draftItinerary: newItinerary,
    itinerary: newItinerary,
    currentItinerary: newItinerary,
    previousItineraries,
  };
}
