// Remove the conversational follow-up questions the LLM appends to the end of
// a generated itinerary. The chat keeps them (they're useful for follow-ups),
// but a saved plan should read as pure itinerary content.

const FOLLOW_UP_STARTER = /^(?:i hope|hope (?:this|you)|to make (?:sure|it)|would you (?:like|prefer|rather)|do you (?:have|want|prefer)|let me know|just let me know|if you(?:'d| would) like|want me to|should i|happy to|anything else|feel free to|which (?:one|would))/i;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+/;

function isQuestionBlock(block: string): boolean {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  const questions = lines.filter((line) => line.endsWith('?'));
  if (questions.length === 0) return false;

  // Numbered/bulleted list of questions.
  if (lines.some((line) => LIST_ITEM.test(line) && line.endsWith('?'))) return true;
  // Two or more questions in one block.
  if (questions.length >= 2) return true;
  // A single question that reads like a follow-up prompt.
  return questions.length / lines.length >= 0.5 && FOLLOW_UP_STARTER.test(lines[0]);
}

function isQuestionLeadIn(block: string): boolean {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return false;
  return FOLLOW_UP_STARTER.test(lines[0]);
}

export function stripFollowUpQuestions(markdown: string): string {
  if (!markdown) return markdown;
  const blocks = markdown.split(/\n{2,}/);
  let removedQuestionBlock = false;

  while (blocks.length > 0) {
    const last = blocks[blocks.length - 1].trim();
    if (!last) {
      blocks.pop();
      continue;
    }
    if (isQuestionBlock(last)) {
      blocks.pop();
      removedQuestionBlock = true;
      continue;
    }
    // Drop the one-line lead-in that introduced the questions.
    if (removedQuestionBlock && isQuestionLeadIn(last)) {
      blocks.pop();
      continue;
    }
    break;
  }

  return blocks.join('\n\n').trim();
}
