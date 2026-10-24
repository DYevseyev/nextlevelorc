// Text for the owner's phone (ntfy). Phones turn a file name like HANDOFF.md into a link to a website:
// .md is a country's domain, so "see HANDOFF.md" opened a stranger's site instead of the request
// (FR-004 #5). A notification never carries a bare .md file name: each one becomes a link to the file on
// GitHub when the project is there, else its name without ".md". Links already in the text stay as they are.
const URL_RE = /\bhttps?:\/\/\S+/gi;
// a file name or path ending in .md, not inside a longer word (README.mdx, notes.md.bak) or a path that goes on
const MD_RE = /(?<![\w.\\/-])([\w.\\/-]*[\w-])\.md(?!\.?[\w\\/-])/gi;

// `link(name)`: the GitHub URL for a file name or path from the text, or null.
export function phoneText(text, { link = () => null } = {}) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    out.push(plain(s.slice(at, m.index), link), m[0]);
    at = m.index + m[0].length;
  }
  out.push(plain(s.slice(at), link));
  return out.join('');
}
const plain = (s, link) => s.replace(MD_RE, (whole, name) => link(`${name}.md`) || name);

// A GitHub web link to a file of the repo at `branch`: https://github.com/<owner>/<name>/blob/<branch>/<path>.
export function githubFileUrl(repo, branch, file) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${enc(branch)}/${enc(file)}`;
}
