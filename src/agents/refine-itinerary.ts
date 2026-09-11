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

// Find a line containing a bold stop name (case-insensitive and fuzzy).
// Returns the line index or -1.
function findStopLine(lines: string[], stopName: string): number {
  const lower = stopName.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const boldMatch = lines[i].match(/\*\*(.+?)\*\*/);
    if (!boldMatch) continue;
    const bold = boldMatch[1].toLowerCase().trim();
    const boldWords = bold.split(/\s+/).filter(Boolean);

    // Exact match — highest priority
    if (bold === lower) return i;

    // Substring containment in either direction
    if (bold.includes(lower) || lower.includes(bold)) return i;

    // Score by overlapping words
    const overlap = words.filter((w) => boldWords.includes(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestIdx = i;
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

// Replace a stop's name and/or description.
function replaceStop(dayBlock: string, edit: ItineraryEdit): string {
  if (!edit.targetStopName) return dayBlock;
  const lines = dayBlock.split('\n');
  const idx = findStopLine(lines, edit.targetStopName);
  if (idx === -1) return dayBlock;

  const newName = edit.newDetails?.name || edit.targetStopName;
  const newDesc = edit.newDetails?.description;

  // Preserve the existing bullet prefix (e.g. "- " or "- ")
  const prefix = lines[idx].match(/^(\s*[-*]?\s*)/)?.[1] || '- ';
  // Preserve existing description if not provided
  if (newDesc) {
    lines[idx] = `${prefix}**${newName}** — ${newDesc}`;
  } else {
    // Replace just the name, keep the rest of the line
    lines[idx] = lines[idx].replace(
      new RegExp(`\\*\\*${escapeRegex(edit.targetStopName)}\\*\\*`, 'i'),
      `**${newName}**`
    );
  }

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

  // Preserve the bullet prefix and the bold name
  const prefix = lines[idx].match(/^(\s*[-*]?\s*)/)?.[1] || '- ';
  const boldMatch = lines[idx].match(/\*\*(.+?)\*\*/);
  const stopName = boldMatch ? boldMatch[1] : edit.targetStopName;
  lines[idx] = `${prefix}**${stopName}** — ${edit.newDetails.description}`;

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
// applyRefinements — LangGraph node for the refine intent
// ---------------------------------------------------------------------------

export async function applyRefinements(
  state: {
    userQuery: string;
    userMessage: string;
    history: PersistedMessage[];
    draftItinerary: string;
    entities: { destination?: string; intent?: string };
  }
): Promise<{ draftItinerary: string; itinerary: string }> {
  // 1. Get the existing itinerary — prefer draftItinerary, then search history.
  const existingItinerary = state.draftItinerary || extractExistingItinerary(state.history);

  if (!existingItinerary) {
    // No existing itinerary to refine — this shouldn't happen because the
    // router checks for destination, but guard against it.
    throw new Error('Refine intent received but no existing itinerary found in history.');
  }

  // 2. Build the prompt for the LLM.
  const destination = state.entities.destination || 'the destination';
  const userQuery = state.userMessage || state.userQuery;

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
- For update_note: provide targetStopName and newDetails.description with the updated description.
- If the user's request cannot be matched to a specific stop, use remove_stop for the closest bolded landmark and add_stop to insert a suitable replacement.
- If the user is giving a dietary or preference constraint (e.g. "I don't drink beer", "no pork", "vegetarian"), remove the offending stop and add an appropriate alternative.
- If the user's request doesn't map to any specific edit and is more of a vague style change, return an empty edits array.
- Match stop names using the exact bolded text in the itinerary. Substrings and common keywords are acceptable (e.g. "Oktoberfest" can match a bolded stop like "Oktoberfest at Bavarian Bierhaus" or "Bavarian Bierhaus").`;

  // 3. Call the LLM with structured output.
  const model = getChatModel(0.2, 'gemini-3.5-flash-lite');
  if (!model) throw new Error('AI provider not configured for refine');

  const structured = (model as any).withStructuredOutput(ItineraryPatchSchema);
  const patch = await structured.invoke(prompt);

  // 4. Validate the patch.
  const validated = ItineraryPatchSchema.parse(patch);

  // 5. Apply the patch deterministically.
  const newItinerary = mergeItineraryPatch(existingItinerary, validated);

  return {
    draftItinerary: newItinerary,
    itinerary: newItinerary,
  };
}
