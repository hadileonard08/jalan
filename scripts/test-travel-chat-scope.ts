import {
  isObviouslyOffTopicTravelRequest,
  OFF_TOPIC_TRAVEL_REPLY,
} from '../src/lib/travel-chat-scope';

let failures = 0;
function check(label: string, input: string, expected: boolean) {
  const actual = isObviouslyOffTopicTravelRequest(input);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(input)}`);
}

console.log('Off-topic requests — blocked before the LLM:');
check('LeetCode', 'Can you solve this LeetCode problem?', true);
check('spaced Leet Code', 'Help me with a Leet Code challenge', true);
check('coding challenge', 'Solve this coding problem using Python', true);
check('implementation request', 'Implement this binary tree algorithm', true);
check('debug request', 'Debug this JavaScript function', true);
check('complexity analysis', 'What is the time complexity of this solution?', true);
check('fenced source code', 'Please explain this:\n```js\nconst x = 1;\n```', true);
check('homework', 'Solve this calculus problem for my homework', true);

console.log('\nTravel requests — allowed through:');
check('local language', 'What language do people speak in Seattle?', false);
check('dress code', 'What is the dress code at this restaurant?', false);
check('cabin class', 'Can we change the flight to business class?', false);
check('airport code', 'What is the airport code for Seattle?', false);
check('route', 'How far is the Space Needle from Pike Place?', false);
check('itinerary edit', 'Replace the museum with the aquarium', false);
check('cost', 'Can you make Day 2 cheaper?', false);
check('empty', '', false);

const expectedReply =
  'I can help with this trip, including places, timing, routes, costs, and itinerary changes. I can’t help with unrelated questions here.';
if (OFF_TOPIC_TRAVEL_REPLY !== expectedReply) {
  failures++;
  console.log('❌ reply copy changed unexpectedly');
} else {
  console.log('\n✅ fixed answer-only reply');
}

console.log(`\nRESULT: ${failures ? `❌ ${failures} FAILED` : '✅ ALL TESTS PASSED'}`);
if (failures) process.exit(1);
