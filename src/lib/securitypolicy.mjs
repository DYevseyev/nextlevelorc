// The security engineer's policy (docs/design/security-engineer.md, 1a-2): the text every scan reads as its knowledge
// base (--knowledge-base /input/kb/policy.md), only once the owner approved exactly that text on the dashboard. Pure.
// Where a text comes from: the scanner's threat model of a trusted scan (a draft: not in the scanner's seal, so the
// hub's record proves only that it is the file the copy-out took), or the base branch's root SECURITY.md (a regular
// file). Either is untrusted text until the owner reads it on its card: made safe here (the .env values redacted,
// control and bidi characters dropped, its length bounded), kept in the guard's blobs by its hash, and approved by that
// hash alone. What is kept, in ~/.nextlevel/guard/<project>/security-policy.json (the hub's and the dashboard's, never
// the project's): { approved: { hash, from, scan, commit, card, at } | null, draftAgain, rejectedDraftAt }.
import { safeText, sha256 } from './findings.mjs';

export const POLICY_MAX = 64 * 1024;
export const POLICY_FILE_NAME = 'security-policy.json';
export const FROM = { draft: "the security engineer's draft", 'SECURITY.md': "the project's SECURITY.md" };

// The threat model of a scan's copied output: threatmodel.md, else a threat_model.md among the sealed files. Only a name
// the hub's record lists (with its hash) can be one. -> its name, or ''
export function threatModelOf(files = {}) {
  const names = Object.keys(files || {});
  if (names.includes('threatmodel.md')) return 'threatmodel.md';
  return names.filter((n) => /(^|\/)threat_?model\.md$/i.test(n)).sort()[0] || '';
}

// A text as a policy: { text, hash, cut } (text '' when nothing is left of it). The text is the safe body alone (P1):
// where it came from is the held record's, so the same text is the same policy whatever commit or scan it came with.
export function policyText(raw, secrets) {
  const body = safeText(String(raw ?? ''), secrets, POLICY_MAX * 2);
  if (!body.trim()) return { text: '', hash: '', cut: 0 };
  const room = POLICY_MAX - 80;
  const cut = Math.max(0, body.length - room);
  const text = `${cut ? `${body.slice(0, room)}\n\n(cut: ${cut} more characters)` : body}\n`;
  return { text, hash: sha256(text), cut };
}

// The kept state, read through a shape check (a field that isn't its type is dropped)
export function readPolicyState(text) {
  let d = null;
  try {
    d = JSON.parse(text);
  } catch {
    d = null;
  }
  const o = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const a = o.approved && typeof o.approved === 'object' ? o.approved : null;
  const approved =
    a && /^[0-9a-f]{64}$/.test(a.hash || '') && FROM[a.from]
      ? { hash: a.hash, from: a.from, scan: str(a.scan), commit: /^[0-9a-f]{40}$/.test(a.commit || '') ? a.commit : '', card: str(a.card), guard: str(a.guard), at: str(a.at) }
      : null;
  return { approved, draftAgain: o.draftAgain === true, rejectedDraftAt: str(o.rejectedDraftAt) };
}
const str = (x) => (typeof x === 'string' ? x.slice(0, 80) : '');

// Whether a trusted scan may draft (P8): none waiting, and either no policy was ever approved and no draft rejected
// since the owner last asked, or the owner asked for a new draft
export const mayDraft = (state, { pending }) => !pending && (state.draftAgain || (!state.approved && !state.rejectedDraftAt));

// The card's words
export const policyWhat = (rec) => (rec.source === 'draft' ? `The security engineer's draft of a security policy, from scan ${rec.scan}` : `The project's SECURITY.md (${String(rec.commit).slice(0, 8)}) as a security policy`);
export const POLICY_WHY = 'A security policy is what every scan reads as its rules: what matters, what is out of scope. Approve makes exactly this text the policy; Reject leaves the policy as it is. Nothing in the project changes either way';
export const DRAFT_WARNING = "The scanner's model wrote this from the code. Read it for anything that puts code out of scope or calls something safe: approved, it steers every scan.";
