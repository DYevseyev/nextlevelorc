// Push a notification to the owner's phone through ntfy (https://ntfy.sh).
//
// The topic comes from NTFY_TOPIC (the project's .env, loaded by the hub); the server from
// nextlevel.json (notifications.server). If NTFY_TOPIC is not set it does nothing, so it is always
// safe to call. Anyone who knows the topic can read what is sent, so every message is redacted the way reports are
// before it leaves (FR-017, lib/redact.mjs): no value of the project's .env (`root`, which every caller names: null
// outside a project), no secret-looking variable of this process, no token shape. This is the only place nextlevel
// talks to ntfy (a test reads src/ for it), so every phone message goes through it: notify, notify --now, the hub's
// outbox (which the orchestrator can write), alerts, the daily report, a handoff answer's message.
// Every text passes phoneText on its way out: no bare .md file names, which phones turn into links to
// websites (FR-004 #5). The hub adds the GitHub links and the handoff items before that.
import { parseEnvFile, parseEnvText } from './lib/envfile.mjs';
import { phoneText } from './lib/phone.mjs';
import { personaHold, phoneSecrets, redactReport } from './lib/redact.mjs';

export { parseEnvFile, parseEnvText };

const PRIORITY = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
const MAX_MESSAGE = 3800; // ntfy's message limit is 4096 bytes

// Load a .env file into process.env (variables already set win). Returns the names it set, so the
// hub can keep them out of what workers see. The tests' own switches never come from a .env (an agent can write one):
// NEXTLEVEL_TEST_STUBS would turn on the test clock and the test hooks, and refuse the real CLIs.
const TESTS_ONLY = (key) => key.startsWith('NEXTLEVEL_TEST_') || key === 'NODE_TEST_CONTEXT';
export function loadEnv(file) {
  const set = [];
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    if (process.env[key] !== undefined || TESTS_ONLY(key)) continue;
    process.env[key] = value;
    set.push(key);
  }
  return set;
}

// The text as it may go to the phone: redacted like a report, for the project at `root`
export function forThePhone(text, root) {
  return redactReport(String(text ?? ''), phoneSecrets({ root }));
}

export async function notify(title, message, { priority = 'default', tags = '', server = 'https://ntfy.sh', root } = {}) {
  if (root === undefined) throw new Error("notify(): name the project's folder (root; null outside a project): its .env values are kept out of every message");
  const held = personaHold(root);
  if (held) {
    console.log(`[notify] not sent: ${held}`);
    return false;
  }
  const secrets = phoneSecrets({ root });
  const hide = (s) => redactReport(String(s ?? ''), secrets);
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[notify] NTFY_TOPIC not set, skipped: ${hide(title)}`);
    return false;
  }
  // (redacted before it is cut: a value cut in half would no longer be found)
  let body = phoneText(hide(message));
  if (body.length > MAX_MESSAGE) body = `${body.slice(0, MAX_MESSAGE)}\n… (truncated)`;
  const payload = {
    topic,
    title: phoneText(hide(title ?? 'nextlevel')),
    message: body,
    priority: PRIORITY[priority] ?? PRIORITY.default,
    tags: tags ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
  // JSON publishing avoids header-encoding problems with non-ASCII titles.
  const res = await fetch(String(server).replace(/\/+$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`[notify] sent: ${payload.title}`);
  return true;
}
