// Releases (safe updates, docs/design/safe-updates.md): the installed tool updates only to a release, an annotated tag
// `vX.Y.Z` on main that a session makes on the commit whose owner check passed. A merge alone never reaches a project.
//
// Tags are fetched into a namespace of nextlevel's own (refs/nextlevel/tags/), with a forced refspec, so a tag that moved
// or vanished on GitHub never makes a fetch fail (a plain `git fetch --tags` refuses to move a local tag and exits 1).
// Then a tag is a release only when all of these hold: its name is vX.Y.Z (no leading zeros, no suffix); it is annotated
// and its message starts with "nextlevel <name>"; its commit is on main's history; it is not older than FIRST_RELEASE
// (the first version that knows releases); and it never moved: every release tag seen is kept in releases.json, and a
// tag whose object or commit is not what was first seen is refused and said, never followed. An update goes only to a
// release that comes after the installed one in main's history and has a higher number.
//
// The notes are the tag's message, in a plain format (Fixes:, New:, After install:, "- " lines, "Safety:" marking a
// safety fix): shown as text, sent to the phone through notify(), never run. Pure, but for the git and store callers.
//
// An install that moved to another repository (the installer's NEXTLEVEL_MOVE_FROM: where nextlevel is published now)
// keeps what it saw of the one it left, each marked `left` with that repository's name: those are never said to be gone,
// and a tag of the same name in the new one is refused like a moved tag (it isn't that release).
import path from 'node:path';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { homeDir } from './home.mjs';

export const RELEASE_NAME = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
// The first release: from here on, every version has the launcher, the channels and (from B) the one-click update, so
// an update can always run from it. A tag below it is not a release.
export const FIRST_RELEASE = 'v0.1.0';
export const TAG_NS = 'refs/nextlevel/tags/';
export const MAIN_REF = 'refs/remotes/origin/main';
// What a fetch brings: the branches (main, and a candidate's), and the tags into nextlevel's namespace. --prune makes a
// vanished tag vanish here too, which is how it is noticed; --no-tags keeps git from making local tags itself.
export const FETCH_ARGS = ['fetch', '--quiet', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', `+refs/tags/v*:${TAG_NS}v*`];

export const parseVersion = (name) => {
  const m = RELEASE_NAME.exec(String(name ?? ''));
  return m ? m.slice(1, 4).map(Number) : null;
};
// <0, 0, >0 like a sort's comparison; a name that isn't a release sorts first
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
export const isReleaseName = (name) => !!parseVersion(name) && compareVersions(name, FIRST_RELEASE) >= 0;

// ---------- the notes ----------
const SECTIONS = { fixes: 'fixes', fix: 'fixes', new: 'added', 'after install': 'afterInstall' };
const MAX_ITEMS = 60;
const MAX_TEXT = 600;
const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
// A tag's message -> { title, fixes, added, afterInstall, other, safety }. Items are { text, safety }; a line under no
// section, or one that isn't an item, is kept in `other` as written. A PGP signature at the end is left out.
export function parseNotes(message) {
  const lines = String(message ?? '').replace(/\r\n/g, '\n').split('\n');
  const sig = lines.findIndex((l) => /^-----BEGIN (PGP|SSH) SIGNATURE-----/.test(l));
  const body = sig >= 0 ? lines.slice(0, sig) : lines;
  const out = { title: '', fixes: [], added: [], afterInstall: [], other: [], safety: false };
  let section = null;
  let last = null;
  for (const raw of body) {
    // (a line is cut before any pattern looks at it: whoever made the tag wrote it)
    const line = raw.slice(0, 4 * MAX_TEXT).trimEnd();
    if (!out.title) {
      if (line.trim()) out.title = clip(line.trim());
      continue;
    }
    const head = /^\s*([A-Za-z ]+):\s*$/.exec(line);
    if (head && SECTIONS[head[1].trim().toLowerCase()]) {
      section = SECTIONS[head[1].trim().toLowerCase()];
      last = null;
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (section && item) {
      const list = out[section];
      if (list.length >= MAX_ITEMS) continue;
      if (section === 'afterInstall') {
        list.push(clip(item[1].trim()));
        last = { list, i: list.length - 1, plain: true };
      } else {
        const safety = /^safety:\s*/i.test(item[1]);
        const text = clip(item[1].replace(/^safety:\s*/i, '').trim());
        list.push({ text, safety });
        if (safety) out.safety = true;
        last = { list, i: list.length - 1 };
      }
      continue;
    }
    if (section && last && /^\s{2,}\S/.test(line)) {
      // a continuation of the item above
      const l = last.list;
      if (last.plain) l[last.i] = clip(`${l[last.i]} ${line.trim()}`);
      else l[last.i] = { ...l[last.i], text: clip(`${l[last.i].text} ${line.trim()}`) };
      continue;
    }
    if (line.trim() && out.other.length < MAX_ITEMS) out.other.push(clip(line.trim()));
    if (!line.trim()) last = null;
  }
  return out;
}

// ---------- which tags are releases ----------
// The message of an annotated tag object, from `git cat-file -p <tag>` (headers, a blank line, the message)
export function tagMessage(catFile) {
  const text = String(catFile ?? '').replace(/\r\n/g, '\n');
  const i = text.indexOf('\n\n');
  return i < 0 ? '' : text.slice(i + 2);
}

// The tags fetched into nextlevel's namespace, judged. `git(args)` -> { ok, out } runs git in the tool's repository;
// `seen`: releases.json's record ({ name: { tag, commit } }). -> { releases (newest first, each { name, commit, tag,
// notes }), refused ([{ name, why }]), vanished (names seen before and gone), seen (the record with the new ones) }.
export function judgeTags(git, { seen = {}, mainRef = MAIN_REF } = {}) {
  const listed = git(['for-each-ref', '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objectname)', TAG_NS]);
  const rows = listed.ok
    ? String(listed.out)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('\t'))
    : [];
  const releases = [];
  const refused = [];
  const next = { ...seen };
  const present = new Set();
  for (const [ref, type, obj, peeled] of rows) {
    const name = ref.slice(TAG_NS.length);
    if (!parseVersion(name)) continue; // v-something that isn't a version: not ours to judge
    present.add(name);
    if (!isReleaseName(name)) continue; // from before releases: never one
    const annotated = type === 'tag';
    const commit = annotated ? peeled : obj;
    const was = seen[name];
    if (was && (was.tag !== (annotated ? obj : '') || was.commit !== commit)) {
      refused.push({
        name,
        why: was.left
          ? `${name} was a release of ${was.left}, the repository this install followed before, and this ${name} is another commit (${String(commit).slice(0, 7)}): nextlevel doesn't take it for that release`
          : `${name} was changed on GitHub after it was published (it pointed at ${String(was.commit).slice(0, 7)}, now ${String(commit).slice(0, 7)}): nextlevel doesn't follow it`,
      });
      continue;
    }
    if (!was) next[name] = { tag: annotated ? obj : '', commit, firstSeen: new Date().toISOString() };
    if (!annotated) {
      refused.push({ name, why: `${name} is a lightweight tag, not an annotated one with release notes: not a release` });
      continue;
    }
    const message = tagMessage(git(['cat-file', '-p', obj]).out);
    const notes = parseNotes(message);
    if (notes.title !== `nextlevel ${name}`) {
      refused.push({ name, why: `${name}'s message doesn't start with "nextlevel ${name}": not a release` });
      continue;
    }
    if (!git(['merge-base', '--is-ancestor', commit, mainRef]).ok) {
      refused.push({ name, why: `${name} isn't on main's history: not a release` });
      continue;
    }
    releases.push({ name, commit, tag: obj, notes });
  }
  const vanished = Object.keys(seen).filter((n) => !present.has(n) && !seen[n]?.left);
  releases.sort((a, b) => compareVersions(b.name, a.name));
  return { releases, refused, vanished, seen: next };
}

// The releases an update from `installed` ({ name, commit }) may go to, newest first: a higher number and, in main's
// history, after the installed commit (both: a higher number on a side branch, or the same commit tagged again, is not
// newer code). No installed release (an install from before releases): every release whose commit isn't older than
// the code installed, or every release when that can't be told.
export function newerReleases(git, releases, installed) {
  return releases.filter((r) => {
    if (!installed?.commit) return true;
    if (r.commit === installed.commit) return false;
    if (installed.name && compareVersions(r.name, installed.name) <= 0) return false;
    return git(['merge-base', '--is-ancestor', installed.commit, r.commit]).ok;
  });
}

// ---------- releases.json: every release tag seen on this PC ----------
export const releasesFile = () => path.join(homeDir(), 'releases.json');
export const readSeen = (file = releasesFile()) => {
  const v = readJsonFile(file, null);
  return v && typeof v.seen === 'object' && v.seen && !Array.isArray(v.seen) ? v.seen : {};
};
// Adds the names first seen now; a name already recorded keeps what it was first seen as (that is the point)
export function recordSeen(seen, file = releasesFile()) {
  updateJsonFile(file, (cur) => {
    const was = cur && typeof cur.seen === 'object' && cur.seen && !Array.isArray(cur.seen) ? cur.seen : {};
    const add = Object.fromEntries(Object.entries(seen).filter(([k]) => !was[k]));
    return { protocol: 1, seen: { ...was, ...add } };
  });
}
// The install moved from the repository `from` (owner/name): what it saw there is kept, marked as that repository's.
// An entry marked already keeps its mark. -> the names marked now
export function leaveSeen(from, file = releasesFile()) {
  const marked = [];
  updateJsonFile(file, (cur) => {
    const was = cur && typeof cur.seen === 'object' && cur.seen && !Array.isArray(cur.seen) ? cur.seen : {};
    const seen = Object.fromEntries(
      Object.entries(was).map(([k, v]) => {
        if (v?.left) return [k, v];
        marked.push(k);
        return [k, { ...v, left: from }];
      }),
    );
    return { protocol: 1, seen };
  });
  return marked;
}
