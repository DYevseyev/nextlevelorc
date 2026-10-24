// The hub's git around a worker (FR-008), the parts that are plain logic: whether the orchestrator's feedback
// asks for the base branch in the task branch, git's conflict markers, and how a merge reads in a job's summary.
// The git commands themselves are in hub.mjs (slotGit, mergeBaseInto, finishTask).

// Feedback that asks for the base branch in the task branch: "merge main into your branch first", "rebase on
// main", "merge the latest origin/main". Not "the merge conflict in main.js" (a file).
export function asksToMerge(feedback, base = 'main') {
  const b = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(merge|rebase)\\b[^.\\n]{0,40}?\\b(origin/)?(${b}|the base branch)(?![\\w/-]|\\.\\w)`, 'i').test(String(feedback || ''));
}

// Whether a file's text still has git's conflict markers (a line that starts with <<<<<<< or >>>>>>>).
export const hasConflictMarkers = (text) => /^(<{7}|>{7})( |$)/m.test(String(text || ''));

// What the hub's merge of the base branch before an attempt did, in a few words ('' when there was nothing to
// merge): { base, result: 'up to date' | 'merged' | 'conflicts' | 'failed', files, resolved, detail }
export function mergeText(m) {
  if (!m || m.result === 'up to date') return '';
  if (m.result === 'merged') return `the hub merged ${m.base} in first`;
  if (m.result === 'conflicts') {
    const files = `${m.files.length} file(s)`;
    return `the hub merged ${m.base} in first: conflicts in ${files}${m.resolved === true ? ', resolved' : m.resolved === false ? ' left unresolved' : ''}`;
  }
  return `the hub couldn't merge ${m.base} in: ${m.detail}`;
}
