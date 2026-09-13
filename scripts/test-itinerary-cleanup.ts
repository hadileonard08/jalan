import assert from 'node:assert/strict';
import { stripFollowUpQuestions } from '../src/lib/itinerary-cleanup';

const itinerary = [
  '## Getting Around Seattle',
  '',
  'The Link Light Rail is your best friend.',
  '',
  '## Day 1 — Wednesday, September 30',
  '',
  '**🌅 Morning:** Pike Place Market.',
  '',
  '**🌙 Evening:** Dinner at Canlis.',
].join('\n');

const cases: { name: string; input: string; expected: string }[] = [
  {
    name: 'removes a closing lead-in with a numbered list of questions',
    input: `${itinerary}\n\nI hope this itinerary gets you excited for your solo adventure! To make sure everything is absolutely perfect for you:\n1. Do you have a preference for the type of food you'd love to try while you're here?\n2. Would you prefer a challenging hike at Mount Rainier, or shorter walks with great viewpoints?`,
    expected: itinerary,
  },
  {
    name: 'removes a single trailing follow-up question',
    input: `${itinerary}\n\nWould you like me to swap any of these stops?`,
    expected: itinerary,
  },
  {
    name: 'removes a bulleted list of questions',
    input: `${itinerary}\n\n- Do you want more museums?\n- Should I add a day trip?`,
    expected: itinerary,
  },
  {
    name: 'keeps an itinerary that does not end with questions',
    input: `${itinerary}\n\n**Tips:** Book Canlis two weeks ahead.`,
    expected: `${itinerary}\n\n**Tips:** Book Canlis two weeks ahead.`,
  },
  {
    name: 'keeps rhetorical questions inside the body of a day',
    input: `${itinerary}\n\n**🌞 Afternoon:** Want the best views? Head to Kerry Park before sunset.`,
    expected: `${itinerary}\n\n**🌞 Afternoon:** Want the best views? Head to Kerry Park before sunset.`,
  },
  {
    name: 'leaves an empty itinerary untouched',
    input: '',
    expected: '',
  },
];

for (const testCase of cases) {
  const actual = stripFollowUpQuestions(testCase.input);
  assert.equal(actual, testCase.expected, testCase.name);
  console.log(`PASS: ${testCase.name}`);
}

console.log('\nAll itinerary cleanup tests passed.');
