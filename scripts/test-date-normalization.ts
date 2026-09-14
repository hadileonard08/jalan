import { findPastCalendarDates, getExpectedTripDays } from '../src/agents/itinerary-checks';
import {
  getTravelDateValidationError,
  normalizeImplicitPastDateRange,
} from '../src/agents/conversation-graph';

const referenceDate = new Date('2026-09-02T12:00:00Z');

const cases = [
  {
    name: 'moves an inferred past year to the next occurrence',
    actual: normalizeImplicitPastDateRange('2025-10-01', '2025-10-06', 'Tokyo in October', referenceDate),
    expected: { startDate: '2026-10-01', endDate: '2026-10-06' },
  },
  {
    name: 'preserves an explicitly requested past year',
    actual: normalizeImplicitPastDateRange('2025-10-01', '2025-10-06', 'Tokyo in October 2025', referenceDate),
    expected: { startDate: '2025-10-01', endDate: '2025-10-06' },
  },
  {
    name: 'preserves an inferred future date',
    actual: normalizeImplicitPastDateRange('2026-10-01', '2026-10-06', 'Tokyo in October', referenceDate),
    expected: { startDate: '2026-10-01', endDate: '2026-10-06' },
  },
];

for (const testCase of cases) {
  const actual = JSON.stringify(testCase.actual);
  const expected = JSON.stringify(testCase.expected);
  if (actual !== expected) {
    throw new Error(`${testCase.name}: expected ${expected}, received ${actual}`);
  }
  console.log(`PASS: ${testCase.name}`);
}

if (!getTravelDateValidationError('2025-10-01', '2025-10-06', referenceDate)) {
  throw new Error('explicitly requested past dates must be rejected');
}
console.log('PASS: rejects explicitly requested past travel dates');

if (getTravelDateValidationError('2026-10-01', '2026-10-06', referenceDate)) {
  throw new Error('future dates must pass validation');
}
console.log('PASS: accepts current or future travel dates');

if (getExpectedTripDays('2026-10-01', '2026-10-05', 5) !== 5) {
  throw new Error('October 1 through October 5 must be exactly five inclusive travel days');
}
console.log('PASS: calculates inclusive trip duration without an extra day');

const pastDates = findPastCalendarDates(
  'Trip 2026-10-01 to 2026-10-06. Skip the event on October 2, 2025.',
  referenceDate,
);
if (JSON.stringify(pastDates) !== JSON.stringify(['October 2, 2025'])) {
  throw new Error(`expected past itinerary event detection, received ${JSON.stringify(pastDates)}`);
}
console.log('PASS: detects past calendar dates inside generated itineraries');
