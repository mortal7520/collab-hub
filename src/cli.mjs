import { ensureRuntimeDirs } from './config.mjs';
import { clearMemberCooldown, getMemberStatuses, openHubDb, setMemberCooldown } from './db.mjs';
import { probeAllMembers } from './prober.mjs';

ensureRuntimeDirs();
const db = openHubDb();
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'probe') {
  console.log(JSON.stringify(await probeAllMembers(db), null, 2));
} else if (cmd === 'status') {
  console.log(JSON.stringify({ members: getMemberStatuses(db) }, null, 2));
} else if (cmd === 'cooldown-set') {
  const [member, seconds = '1800', ...reason] = rest;
  console.log(JSON.stringify(setMemberCooldown(db, member, Number(seconds), reason.join(' ') || 'Manual cooldown'), null, 2));
} else if (cmd === 'cooldown-clear') {
  console.log(JSON.stringify(clearMemberCooldown(db, rest[0]), null, 2));
} else {
  console.log('Usage: node src/cli.mjs <probe|status|cooldown-set|cooldown-clear>');
}
