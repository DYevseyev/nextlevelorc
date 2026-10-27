// The security engineer's scanner: OpenAI's Codex Security image, pinned (docs/design/security-engineer.md, delta 1 D4).
// The image's index digest, its version and the openai/codex-security commit it was built from (its
// org.opencontainers.image.revision label) are pinned together with the seccomp profile from that commit, which nextlevel
// ships (docker/codex-security-seccomp.json, NOTICE). A new digest comes only with a nextlevel release, never at run time.
// Measured on a real Windows PC (Docker Desktop 4.87.0) before it was pinned: Step 0b, 27 October 2026.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'ghcr.io/openai/codex-security';
export const DIGEST = 'sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc';
export const VERSION = '0.7.0';
export const REVISION = 'f05a0b096cc881242ddf34a4d6b3ce0f322f3cf9';
export const SECCOMP_SHA256 = '4d9767cdcdc79338c0ce172baab5042d1c5a7d847a0d73a10e308f54c44a286d';
export const SECCOMP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'codex-security-seccomp.json');

// The image's own user (codex-security), and Codex inside it, which the probes run directly
export const SCAN_USER = '10001:10001';
export const CODEX_JS = '/usr/local/lib/node_modules/@openai/codex-security/node_modules/@openai/codex/bin/codex.js';

export const imageRef = () => `${IMAGE}@${DIGEST}`;
// A short name for the pinned image, for the owner
export const imageWords = () => `Codex Security ${VERSION} (${IMAGE}@${DIGEST.slice(0, 19)}...)`;

// '' when the shipped profile is the pinned one, else why not (a missing or changed file: no scan runs)
export function seccompProblem(file = SECCOMP_FILE) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return `the scanner's seccomp profile is missing (${file}): install nextlevel again`;
  }
  const hash = createHash('sha256').update(data).digest('hex');
  return hash === SECCOMP_SHA256 ? '' : `the scanner's seccomp profile isn't the pinned one (sha256 ${hash.slice(0, 12)}..., expected ${SECCOMP_SHA256.slice(0, 12)}...): install nextlevel again`;
}
