// Page back through a real session log and confirm the pages join up without
// gaps or repeats, which synthetic fixtures alone cannot prove.
import { readTranscript } from '../sidecar/dist/sidecar/src/eventLog.js';

const sessionId = process.argv[2];
const pages = Number(process.argv[3] ?? 3);

let cursor;
const ids = [];

for (let page = 0; page < pages; page += 1) {
  const started = Date.now();
  const result = await readTranscript(sessionId, 500, cursor);
  console.log(
    `page ${page}: ${result.events.length} events in ${Date.now() - started}ms, nextBefore=${result.nextBefore}`,
  );

  ids.unshift(...result.events.map((event) => event.id));
  if (result.nextBefore === null) {
    console.log('reached the start of the log');
    break;
  }
  cursor = result.nextBefore;
}

console.log(`collected ${ids.length} events, ${new Set(ids).size} unique`);
console.log(ids.length === new Set(ids).size ? 'no repeats across pages' : 'REPEATS DETECTED');
