// Yes/no questions on the console, for commands that ask the owner before they change something (init,
// report, fix). Answers can also be piped in, one per line; no answer (end of input) is "no", so a run
// without a person at the keyboard never says yes by itself.
import readline from 'node:readline';

export function makeAsker({ onNoAnswer = '(no answer: keeping yours)' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued = [];
  let waiting = null;
  let closed = false;
  const deliver = (text) => {
    const w = waiting;
    waiting = null;
    w(text);
  };
  rl.on('line', (l) => (waiting ? deliver(l) : queued.push(l)));
  rl.on('close', () => {
    closed = true;
    if (waiting) deliver(null);
  });
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  // The next line typed after `prompt`, or null when there is none (end of input). Piped answers may all have been read
  // (and the input ended) while the command waited for something else, such as gh filing a report: the prompt is still
  // shown, and a line read before it is still its answer.
  const answer = async (prompt) => {
    if (closed) process.stdout.write(prompt);
    else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    let line;
    if (queued.length) line = queued.shift();
    else if (closed) line = null;
    else line = await new Promise((r) => (waiting = r));
    if (line !== null && !process.stdin.isTTY) process.stdout.write(`${line}\n`);
    return line;
  };
  return {
    async yes(question, { noAnswer = onNoAnswer } = {}) {
      const line = await answer(`${question} [y/N] `);
      if (line === null) process.stdout.write(`${noAnswer}\n`);
      return /^y/i.test(line ?? '');
    },
    // Free text ('' when there is no answer): the doctor's fixes ask this way (makeUi in doctor.mjs)
    question: async (prompt) => (await answer(prompt)) ?? '',
    close: () => rl.close(),
  };
}
