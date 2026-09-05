// Exercise the sidebar ordering rules directly, since they are pure logic and the
// failure mode (sessions shuffling under the cursor) is hard to spot by eye.
import { orderSessions } from '../src/lib/ordering.ts';

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

const session = (id, updatedAt, loaded = false) => ({
  sessionId: id,
  title: id,
  cwd: null,
  repository: null,
  branch: null,
  createdAt: updatedAt,
  updatedAt,
  preview: null,
  loaded,
});

const ids = (list) => list.map((s) => s.sessionId);

// Inactive sessions sort by last use.
check(
  'inactive sorted by last use',
  ids(orderSessions([session('a', '2026-09-05 10:00:00'), session('b', '2026-09-05 12:00:00')], [])),
  ['b', 'a'],
);

// Active sessions group above every inactive one, regardless of their timestamps.
check(
  'active grouped on top',
  ids(
    orderSessions(
      [
        session('old-active', '2020-01-01 00:00:00', true),
        session('fresh-inactive', '2026-09-05 12:00:00'),
      ],
      ['old-active'],
    ),
  ),
  ['old-active', 'fresh-inactive'],
);

// The core requirement: activity must not reshuffle the active group.
const active = [
  session('a', '2026-09-05 10:00:00', true),
  session('b', '2026-09-05 11:00:00', true),
  session('c', '2026-09-05 09:00:00'),
];
const order = ['b', 'a']; // b activated most recently
check('active ordered by activation, not last use', ids(orderSessions(active, order)), ['b', 'a', 'c']);

// Sending into `a` updates its timestamp; its position must not move.
const afterSend = [
  session('a', '2026-09-05 13:00:00', true),
  session('b', '2026-09-05 11:00:00', true),
  session('c', '2026-09-05 09:00:00'),
];
check('sending does not reorder the active group', ids(orderSessions(afterSend, order)), ['b', 'a', 'c']);

// A newly activated session enters at the top of the group.
check(
  'newly active goes to the top',
  ids(orderSessions([...afterSend.map((s) => ({ ...s })), session('d', '2026-09-05 08:00:00', true)], ['d', 'b', 'a'])),
  ['d', 'b', 'a', 'c'],
);

// A session loaded before this client observed it has no rank and sorts last in the group.
check(
  'unranked active sorts last within the group',
  ids(
    orderSessions(
      [session('ranked', '2026-09-05 10:00:00', true), session('unranked', '2026-09-05 12:00:00', true)],
      ['ranked'],
    ),
  ),
  ['ranked', 'unranked'],
);

console.log(failures === 0 ? '\nall ordering checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
