// What the runtime will tell us about user settings, and whether the CLI's own display
// preferences are among them.
//
// The question behind this: /statusline and /footer configure which items the CLI shows in
// its status line, and this app draws its own chrome. If those preferences are shared
// configuration rather than terminal state, honouring them costs nothing and means one
// place to set them for both. They are - footer, sidebar, statusLine, theme and ide are all
// ordinary settings keys, readable with no session open.
//
//   node scripts/probe-settings.mjs
import { CopilotClient } from '@github/copilot-sdk';

import { resolveCliPath } from '../sidecar/dist/sidecar/src/paths.js';

const cliPath = resolveCliPath();
if (!cliPath) {
  console.error('no Copilot CLI found');
  process.exit(1);
}

const client = new CopilotClient({ cliPath });
await client.start();

// settings.json overlaid with the legacy config.json, every known key present whether or
// not it was ever set, each with its effective value and its default.
const { settings } = await client.rpc.user.settings.get();
const keys = Object.keys(settings);
console.log(`${keys.length} settings\n`);

// The display preferences this app could answer to.
for (const key of ['footer', 'sidebar', 'statusLine', 'theme', 'ide']) {
  console.log(`${key}: ${JSON.stringify(settings[key])}`);
}

console.log('\nall keys:', keys.join(', '));

await client.stop();
process.exit(0);
