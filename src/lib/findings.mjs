// The security engineer's findings (docs/design/security-engineer.md §7, delta 2 V3): what the scanner wrote, made into
// nextlevel's findings by code. Pure. A scan of a repository an attacker may have written is untrusted text from end to
// end: every field is shape-checked to its type (one that isn't is dropped), its text redacted and stripped of control
// and bidi characters, its paths kept as names inside the checkout (never read), and nothing upgrades a finding. The
// files count only when the scanner's seal checks out (sealedAt, each listed file's sha256) and their hash matches the
// hub's own record of the copy.
import { createHash } from 'node:crypto';
import { redactReport } from './redact.mjs';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const LEVEL = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', informational: 'info', info: 'info' };

// The three states (R6). The scanner's validation record is free text in its schema, so only these exact values count;
// the list grows from real output, never from words in a summary. Step 0b's real record was a static source trace.
export const REPRODUCED = new Set(['reproduced']);
export const BY_SOURCE = new Set(['validated', 'verified', 'confirmed', 'succeeded']);
export const STATES = { reproduced: 'reproduced', source: 'validated by source', none: 'not validated' };

// What the copy-out takes besides the files the manifest lists (each only when present)
export const EXTRA_FILES = ['report.md', 'threatmodel.md', 'coverage.json'];
export const MANIFEST = 'scan-manifest.json';
export const COPY_LIMITS = { file: 16 * 1024 * 1024, total: 64 * 1024 * 1024 };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const CONTROL_CHARS = '\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff';
const CONTROL = new RegExp(`[${CONTROL_CHARS}]`, 'g');
const HAS_CONTROL = new RegExp(`[${CONTROL_CHARS}\\n\\r\\t]`);

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, max) => (typeof x === 'string' && x.trim() ? x.slice(0, max) : '');
const int = (x) => (Number.isInteger(x) && x >= 0 && x < 1e9 ? x : null);

// A name the copy-out may take (V3): plain and relative, "/" between parts, no "..", no drive, no reserved Windows name,
// at most two folders deep. '' when it may, else why not.
export function unsafeName(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return 'not a name';
  if (/[\\:*?"<>|]/.test(rel) || HAS_CONTROL.test(rel) || rel.startsWith('/')) return 'not a plain relative name';
  const parts = rel.split('/');
  if (parts.length > 3) return 'more than two folders deep';
  for (const p of parts) {
    if (!p || p === '.' || p === '..') return 'a name with an empty, "." or ".." part';
    if (WINDOWS_RESERVED.test(p) || /[. ]$/.test(p)) return `a name Windows reads differently (${p})`;
  }
  return '';
}

// The manifest, shape-checked: { manifest } or { problem }
export function readManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { problem: 'the scan manifest is not JSON' };
  }
  const s = m?.scan;
  if (!isObj(m) || m.documentType !== 'codex-security.scan-manifest' || !isObj(s)) return { problem: "the scan manifest isn't the scanner's" };
  if (!Array.isArray(s.artifacts) || !s.artifacts.length) return { problem: 'the scan manifest lists no files' };
  const artifacts = [];
  for (const a of s.artifacts) {
    if (!isObj(a) || typeof a.path !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256 || '')) return { problem: 'the scan manifest lists a file without its sha256' };
    const why = unsafeName(a.path);
    if (why) return { problem: `the scan manifest lists an unsafe name (${why})` };
    if (artifacts.some((b) => b.path.toLowerCase() === a.path.toLowerCase())) return { problem: 'the scan manifest lists a file twice' };
    artifacts.push({ path: a.path, sha256: a.sha256 });
  }
  return {
    manifest: {
      scanId: str(s.id, 120),
      status: ['completed', 'failed', 'canceled', 'interrupted'].includes(s.status) ? s.status : '',
      startedAt: str(s.startedAt, 40),
      completedAt: str(s.completedAt, 40),
      sealedAt: str(s.sealedAt, 40),
      producer: str(s.producer?.version, 40),
      revision: str(s.target?.revision, 80),
      findingsRef: s.findingsRef === 'findings.json' ? 'findings.json' : '',
      coverageRef: s.coverageRef === 'coverage.json' ? 'coverage.json' : '',
      artifacts,
    },
  };
}

// What to copy out, in order (the manifest itself is first, on its own)
export function copyList(manifest, present = () => true) {
  const names = manifest.artifacts.map((a) => a.path);
  for (const f of EXTRA_FILES) if (!names.some((n) => n.toLowerCase() === f) && present(f)) names.push(f);
  return names;
}

// The seal (the scanner's): sealed when the scan completed, sealedAt is its completedAt, the findings and coverage are
// listed, and every listed file's hash is the copied one's. hashes: { rel: sha256 } of the copied files. '' or why not.
export function sealProblem(manifest, hashes) {
  if (manifest.status !== 'completed') return `the scan didn't complete (${manifest.status || 'no status'})`;
  if (!manifest.sealedAt || manifest.sealedAt !== manifest.completedAt) return "the scan's files aren't sealed";
  if (!manifest.findingsRef || !manifest.artifacts.some((a) => a.path === 'findings.json')) return "the seal doesn't cover the findings";
  for (const a of manifest.artifacts) {
    if (!(a.path in hashes)) return `a sealed file is missing (${a.path})`;
    if (hashes[a.path] !== a.sha256) return `a sealed file changed (${a.path})`;
  }
  return '';
}

// A text made safe to keep and show: control and bidi characters dropped, secrets redacted, cut to max
export function safeText(x, { values = [], names = [], home = '' } = {}, max = 4000) {
  if (typeof x !== 'string') return '';
  const cleaned = x.replace(CONTROL, ' ').replace(/\r\n?/g, '\n');
  return redactReport(cleaned, { values, names, home }).slice(0, max).trim();
}

// A location's path, as a name inside the checkout (never used to read or write): '' when it isn't one
export function safePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return '';
  const rel = p.replace(/^\/input\/repository\//, '').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || HAS_CONTROL.test(rel)) return '';
  if (rel.split('/').some((part) => part === '..' || part === '')) return '';
  return rel;
}

// How far the scanner validated a finding, from its record's exact values only
export function stateOf(v) {
  if (!isObj(v)) return 'none';
  const vals = ['status', 'result'].map((k) => (typeof v[k] === 'string' ? v[k].trim().toLowerCase() : ''));
  if (vals.some((x) => REPRODUCED.has(x))) return 'reproduced';
  if (vals.some((x) => BY_SOURCE.has(x))) return 'source';
  return 'none';
}

// The findings file made into nextlevel's findings: { scanId, findings: [...] } or { problem } (a file that can't be read
// ends the scan "failed", never "nothing found")
export function readFindings(text, secrets = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problem: 'the findings file is not JSON' };
  }
  if (!isObj(doc) || doc.documentType !== 'codex-security.findings' || !Array.isArray(doc.findings)) return { problem: "the findings file isn't the scanner's" };
  const t = (x, max) => safeText(x, secrets, max);
  const findings = [];
  for (const f of doc.findings.slice(0, 500)) {
    if (!isObj(f)) continue;
    const id = typeof f.findingId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(f.findingId) ? f.findingId : '';
    const severity = LEVEL[f.severity?.level];
    const title = t(f.title, 300);
    if (!id || !severity || !title) continue; // (a finding without its id, severity or title isn't one)
    const key = typeof f.fingerprints?.primary === 'string' && /^[A-Za-z0-9_.:=+/-]{1,200}$/.test(f.fingerprints.primary) ? f.fingerprints.primary : id;
    const where = (Array.isArray(f.locations) ? f.locations : [])
      .slice(0, 20)
      .map((l) => (isObj(l) ? { path: safePath(l.path), line: int(l.startLine), end: int(l.endLine) } : null))
      .filter((l) => l && l.path);
    const evidence = (Array.isArray(f.codeEvidence) ? f.codeEvidence : []).slice(0, 10).map((e) => (isObj(e) ? t(e.explanation, 1000) : '')).filter(Boolean).join('\n\n');
    const v = isObj(f.validation) ? f.validation : null;
    findings.push({
      id,
      key,
      severity,
      title,
      category: t(f.taxonomy?.category, 120),
      confidence: ['high', 'medium', 'low'].includes(f.confidence?.level) ? f.confidence.level : '',
      where,
      what: t(f.summary, 4000),
      evidence: t(evidence, 4000),
      validation: { state: stateOf(v), method: t(v?.method, 300), summary: t(v?.summary, 1000) },
      fix: t(f.remediation, 4000),
    });
  }
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id));
  return { scanId: str(doc.scanId, 120), findings };
}

// The coverage file's few facts: { partial, files, summary } (a scan that says it covered less is partial)
export function readCoverage(text, secrets = {}) {
  let c;
  try {
    c = JSON.parse(text);
  } catch {
    return { partial: true, summary: 'no coverage file the scanner wrote' };
  }
  if (!isObj(c)) return { partial: true, summary: 'no coverage file the scanner wrote' };
  const deferred = Array.isArray(c.deferred) ? c.deferred.length : 0;
  return { partial: deferred > 0, deferred, includePaths: Array.isArray(c.includePaths) ? c.includePaths.length : 0, summary: safeText(typeof c.inventoryStrategy === 'string' ? c.inventoryStrategy : '', secrets, 300) };
}

// Counts by severity, for a line
export function counts(findings) {
  const n = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) n[f.severity]++;
  return n;
}
export const countsText = (findings) => {
  const n = counts(findings);
  const parts = SEVERITIES.filter((s) => n[s]).map((s) => `${n[s]} ${s}`);
  return parts.length ? parts.join(', ') : 'no findings';
};
