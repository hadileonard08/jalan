/**
 * Unit tests for scoreImageRelevance.
 * Run: npx tsx scripts/test-image-scoring.ts
 * No API calls and no Gemini tokens required.
 */

import { scoreImageRelevance } from '../src/agents/destination-images';

interface Assertion {
  name: string;
  ok: boolean;
  message: string;
}

const assertions: Assertion[] = [];

function assert(name: string, ok: boolean, message: string) {
  assertions.push({ name, ok, message });
}

// 1. "Colosseum" matches "Colosseo" via Levenshtein distance.
const colosseoScore = scoreImageRelevance({ title: '', tags: ['Colosseo'] }, 'Colosseum');
assert('Colosseum ~ Colosseo (Levenshtein)', colosseoScore > 0.5, `score=${colosseoScore}`);

// 2. "Senso-ji Temple" matches "Sensoji" via Levenshtein or substring.
const sensojiScore = scoreImageRelevance({ title: '', tags: ['Sensoji'] }, 'Senso-ji Temple');
assert('Senso-ji Temple ~ Sensoji (substring/Levenshtein)', sensojiScore >= 0.5, `score=${sensojiScore}`);

// 3. "Uffizi Gallery" matches "Uffizi Galleries" via stemming.
const uffiziScore = scoreImageRelevance({ title: '', tags: ['Uffizi Galleries'] }, 'Uffizi Gallery');
assert('Uffizi Gallery ~ Uffizi Galleries (stemming)', uffiziScore >= 0.9, `score=${uffiziScore}`);

// 4. "Austin" does NOT match "Austria" (old 5-char prefix bug must be gone).
const austinScore = scoreImageRelevance({ title: '', tags: ['Austria'] }, 'Austin');
assert('Austin does not match Austria', austinScore === 0, `score=${austinScore}`);

// 5. Person/portrait tags halve the final score.
const noPersonScore = scoreImageRelevance({ title: '', tags: ['paris', 'eiffel tower'] }, 'Paris');
const personScore = scoreImageRelevance({ title: '', tags: ['paris', 'eiffel tower', 'portrait', 'woman'] }, 'Paris');
assert('person tags slash score by 50%', Math.abs(personScore - noPersonScore * 0.5) < 1e-9, `score=${personScore} vs ${noPersonScore}`);

// Extra: mismatch gate still rejects sports venues for cultural landmarks.
const stadiumScore = scoreImageRelevance({ title: '', tags: ['Meiji Jingu Stadium'] }, 'Meiji Jingu Shrine');
assert('mismatch gate rejects stadium for shrine', stadiumScore === 0, `score=${stadiumScore}`);

let failed = 0;
for (const a of assertions) {
  console.log(`${a.ok ? 'PASS' : 'FAIL'}: ${a.name} — ${a.message}`);
  if (!a.ok) failed++;
}

if (failed > 0) {
  console.log(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${assertions.length} image scoring tests passed.`);
