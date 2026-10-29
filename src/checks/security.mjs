// The security engineer's checks (docs/design/security-engineer.md §9, deltas 1 and 2): its scans run in OpenAI's scanner
// container, so what it needs is Docker with Linux containers and its API closed, the pinned image, a sign-in in its own
// volume, Codex's sandbox holding inside the container (the model-free probe, kept for the image's digest), and Daybreak
// Blue for the chosen model. Information while the role is off; errors while it is on, and nothing falls back to the host's
// Codex or a plugin.
import { securityProfile } from '../lib/config.mjs';
import { projectKey } from '../lib/guard.mjs';
import { DIGEST, SECCOMP_FILE, imageRef, imageWords, seccompProblem } from '../lib/securityimage.mjs';
import { accessPrograms, apiPortOpen, apiPortWords, daybreakFor, dockerFacts, dockerSettingsText, imagePresent, pullArgs, runProbes, signedIn } from '../lib/securityrun.mjs';
import { accountKey, volumes } from '../lib/securityspec.mjs';
import { fail, inProject, pass, step } from './lib.mjs';

const off = (ctx) => (ctx.root && securityProfile(ctx.config) ? null : 'the security engineer is off');
const docker = (ctx) => (args, opts) => ctx.run('docker', args, { cwd: ctx.root || ctx.cwd, direct: true, ...opts });
// Docker Desktop's settings, read for one key (never shown): Windows only
const settingsText = (ctx) => dockerSettingsText({ platform: ctx.platform, env: ctx.env, read: ctx.read, join: ctx.path.join });
const TCP_STEP = 'Docker Desktop: Settings, General: turn off "Expose daemon on tcp://localhost:2375 without TLS", then Apply';
const accountOf = (ctx) => accountKey(securityProfile(ctx.config)?.name || '');
export const securityVolumes = (ctx) => volumes({ projectKey: projectKey(ctx.root), account: accountOf(ctx) });

// A check that mounts the sign-in volume while a scan, a sign-in or the Daybreak watch holds the PC's lease: information,
// with no docker run, and asked again next time (team set refuses to save on it: src/team.mjs)
const busy = (who) => fail(`${who} is using the scanner's sign-in now: checked again after it`, { severity: 'info', busy: true });

export const PROBES = 'security.probes'; // check-cache.json: { [image digest]: { ok, problem, answer, at } }

export const securityDockerCheck = {
  id: 'security.docker',
  title: 'Docker for the security engineer',
  severity: 'error',
  learnMore: 'docs/CHECKS.md#securitydocker',
  skipIf: off,
  async run(ctx) {
    const bad = seccompProblem(SECCOMP_FILE);
    if (bad) return fail(bad, { steps: [step('terminal', 'nextlevel update')] });
    const f = dockerFacts(docker(ctx), { settingsText: settingsText(ctx) });
    if (f.missing) return fail(`not installed: the security engineer's scans run in Docker`, { steps: [ctx.platform === 'win32' ? step('terminal', 'winget install -e --id Docker.DockerDesktop') : step('browser', 'https://docs.docker.com/get-docker/')] });
    if (f.stopped) return fail(f.why, { next: 'start Docker Desktop', steps: [step('app', null, { text: 'start Docker Desktop and wait until it says "Engine running"' })] });
    if (!f.ok) return fail(f.why, { steps: [step('app', null, { text: f.tcp ? TCP_STEP : 'Docker Desktop: switch to Linux containers (its tray menu)' })] });
    // (the ports too, whatever the setting says: delta 1's stop rule)
    const port = await (ctx.tcpOpen ? ctx.tcpOpen([2375, 2376]) : apiPortOpen());
    if (port) return fail(apiPortWords(port), { steps: [step('app', null, { text: TCP_STEP })] });
    return pass(`${f.detail}${f.apparmor ? '; no AppArmor profile is loaded for the scanner (Docker Desktop has none)' : ''}`);
  },
};

export const securityImageCheck = {
  id: 'security.image',
  title: "The security engineer's scanner",
  severity: 'error',
  learnMore: 'docs/CHECKS.md#securityimage',
  skipIf: off,
  requires: ['security.docker'],
  run(ctx) {
    if (imagePresent(docker(ctx))) return pass(imageWords());
    return fail(`not on this PC yet: ${imageWords()}`, { next: 'pull it (about 1.4 GB, once per nextlevel release that changes it)', steps: [step('terminal', `docker pull ${imageRef()}`)] });
  },
  fixPrompt: () => `Download OpenAI's Codex Security scanner (docker pull, about 1.4 GB)?`,
  fix(ctx, ui) {
    ui.run('docker', pullArgs());
  },
  fixInWindow: true, // (an install: the owner's, in their own window)
};

export const securityLoginCheck = {
  id: 'security.login',
  title: "The security engineer's sign-in",
  severity: 'error',
  learnMore: 'docs/CHECKS.md#securitylogin',
  skipIf: off,
  requires: ['security.image'],
  run(ctx) {
    const s = ctx.signInLease(() => signedIn(docker(ctx), securityVolumes(ctx), { seccomp: SECCOMP_FILE }));
    if (s.busy) return busy(s.busy);
    if (s.ok) return pass('signed in, in its own Docker volume (OpenAI\'s device sign-in; nextlevel never reads it)');
    return fail(`${s.why}: the scanner signs in once with your ChatGPT account, on OpenAI's own page`, {
      next: 'sign in',
      steps: [inProject(ctx, `nextlevel security login${securityProfile(ctx.config)?.name ? ` --profile ${securityProfile(ctx.config).name}` : ''}`)],
    });
  },
};

export const securityProbeCheck = {
  id: 'security.probe',
  title: "The scanner's sandbox",
  severity: 'error',
  learnMore: 'docs/CHECKS.md#securityprobe',
  skipIf: off,
  requires: ['security.image'],
  run(ctx) {
    const kept = ctx.cache.get(PROBES)?.[DIGEST];
    let v = kept && !ctx.fresh ? kept : null;
    if (!v) {
      // (the state volume, where the sign-in's folder is mounted: under the lease too)
      const r = ctx.signInLease(() => runProbes(docker(ctx), { seccomp: SECCOMP_FILE, account: accountOf(ctx), stateVolume: securityVolumes(ctx).state }));
      if (r.busy) return busy(r.busy);
      v = { ...r, at: new Date().toISOString() };
    }
    if (v !== kept && v.kept) ctx.cache.set(PROBES, { ...(ctx.cache.get(PROBES) || {}), [DIGEST]: v });
    if (v.ok) return pass(`inside the scanner, Codex's sandbox hides the sign-in and closes the network (${(v.answer || []).join(', ')})`);
    return fail(`${v.problem}: no scan runs with this scanner`, { next: "tell nextlevel's developers", steps: [inProject(ctx, 'nextlevel report security.probe')] });
  },
};

// The chosen model and Daybreak Blue, from the scanner's own Codex. A role without a model gets the first that works
// (`pick`, which nextlevel team saves).
export const securityDaybreakCheck = {
  id: 'security.daybreak',
  title: 'Daybreak for the security engineer',
  severity: (ctx) => (ctx.config.roles.security?.daybreak ? 'error' : 'info'),
  learnMore: 'docs/CHECKS.md#securitydaybreak',
  skipIf: off,
  requires: ['security.login'],
  run(ctx) {
    const p = securityProfile(ctx.config);
    const r = ctx.signInLease(() => accessPrograms(docker(ctx), securityVolumes(ctx), { seccomp: SECCOMP_FILE }));
    if (r.busy) return busy(r.busy);
    if (!r.ok) return fail(`the scanner's Codex couldn't list its models (${r.why})`, { severity: 'warn' });
    if (!p.daybreak) {
      const model = p.model || r.models[0].id;
      return fail(`standard safeguards on ${model}: OpenAI's cyber screening may block parts of a scan`, { ...(p.model ? {} : { pick: model }), next: 'turn Daybreak on (Team page) for a model it covers' });
    }
    if (!p.model) {
      const first = r.models.find((m) => daybreakFor(m) === 'works');
      if (first) return pass(`Daybreak Blue works on ${first.id} (the scanner's Codex lists it)`, { pick: first.id });
      const maybe = r.models.find((m) => daybreakFor(m) === 'unconfirmed');
      if (maybe) return pass(`Daybreak unconfirmed on ${maybe.id}: Codex says nothing of its access programs`, { pick: maybe.id, unconfirmed: true });
      return fail('no model of this account takes Daybreak Blue', { next: 'turn Daybreak off, or ask OpenAI for its cyber access program' });
    }
    const m = r.models.find((x) => x.id === p.model);
    const v = daybreakFor(m);
    if (v === 'works') return pass(`Daybreak Blue works on ${p.model}`);
    if (v === 'unconfirmed') return pass(`Daybreak unconfirmed on ${p.model}: Codex says nothing of its access programs`, { unconfirmed: true });
    return fail(m ? `${p.model} doesn't take Daybreak Blue (${m.programs.join(', ') || 'no access program'})` : `${p.model} isn't among the scanner's models`, { next: 'choose a model Daybreak covers, or turn Daybreak off' });
  },
};

export const securityChecks = [securityDockerCheck, securityImageCheck, securityLoginCheck, securityProbeCheck, securityDaybreakCheck];
