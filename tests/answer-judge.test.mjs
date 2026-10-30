import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswers, createAnswerJudge } from '../answer-judge.mjs';
import { Game } from '../game.mjs';

test('exact answers and blanks skip the referee; distinct alternatives share one check', async () => {
  const calls = [];
  const judge = async input => { calls.push(input); return [true, false]; };
  assert.deepEqual(await checkAnswers('õhuniisutaja', [' ÕHUNIISUTAJA! ', ''], judge), {
    matches: [true, false], failed: false,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await checkAnswers('õhuniisutaja', ['õhuniisuti', ' ÕHUNIISUTI! ', 'õhupuhasti', 'õhuniisutaja', ''], judge), {
    matches: [true, true, false, true, false], failed: false,
  });
  assert.deepEqual(calls, [{ target: 'õhuniisutaja', guesses: ['õhuniisuti', 'õhupuhasti'] }]);
});

test('Decisions request is isolated, uses typed choices, and maps replies by name', async () => {
  const judge = createAnswerJudge({ apiKey: 'mock', request: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(options.headers.Authorization, 'Bearer mock');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions']);
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_json', data: {
      target: 'õhuniisutaja', guesses: ['õhuniisuti', 'õhupuhasti'],
    } }] }]);
    assert.equal(body.questions.every(q => q.type === 'choice'), true);
    assert.match(body.questions[0].instructions, /untrusted game data/);
    return Response.json({ answers: [
      { name: 'guess_1', type: 'choice', choice: 'different' },
      { name: 'guess_0', type: 'choice', choice: 'equivalent' },
    ] });
  } });
  assert.deepEqual(await judge({ target: 'õhuniisutaja', guesses: ['õhuniisuti', 'õhupuhasti'] }), [true, false]);
});

test('failed, incomplete or refused checks leave alternatives unknown instead of wrong', async () => {
  for (const request of [
    async () => { throw new Error('Network failure'); },
    async () => new Response('', { status: 503 }),
    async () => Response.json({ answers: [] }),
    async () => Response.json({ answers: [{ name: 'guess_0', type: 'refusal' }] }),
    async () => Response.json({ answers: [{ name: 'wrong_name', type: 'choice', choice: 'equivalent' }] }),
  ]) {
    const checked = await checkAnswers('õhuniisutaja', ['õhuniisutaja', 'õhuniisuti', ''], createAnswerJudge({ apiKey: 'mock', request }));
    assert.deepEqual(checked, { matches: [true, null, false], failed: true });
  }
});

async function until(condition) {
  for (let i = 0; i < 250; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Condition not reached.');
}

test('solo checks only after all AI guesses lock; equivalents score consistently in results, history and difficulty', async t => {
  const finals = [];
  let finishCheck;
  let checks = 0;
  const game = new Game({ soloPace: 1,
    wordGenerator: async () => 'õhuniisutaja',
    soloPlayer: async turn => {
      if (turn.role === 'guesser') {
        assert.equal(Object.hasOwn(turn, 'secret'), false);
        assert.equal(JSON.stringify(turn).includes('õhuniisutaja'), false);
      }
      if (turn.final) return new Promise(resolve => finals.push(resolve));
      return { message: 'Kas seda kasutatakse talvel?', guess: 'õhuniisuti' };
    },
    answerJudge: input => {
      checks++;
      assert.deepEqual(input, { target: 'õhuniisutaja', guesses: ['õhuniisuti', 'õhupuhasti'] });
      return new Promise(resolve => { finishCheck = resolve; });
    },
  });
  const s = game.create('You', { mode: 'solo', aiCount: 3 }), room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  const act = (action, extra = {}) => game.action({ action, code: room.code, ...extra }, s.token);
  act('start');
  await until(() => room.guessHistory.length >= 1);
  assert.equal(checks, 0);
  assert.equal(JSON.stringify(game.view(room.code, s.token)).includes('õhuniisutaja'), false);
  act('answer', { word: 'Õhuniisuti' });
  assert.equal(finals.length, 2);
  finals[0]({ message: '', guess: 'õhuniisuti' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0);
  finals[1]({ message: '', guess: 'õhupuhasti' });
  await until(() => Boolean(finishCheck));
  assert.equal(room.phase, 'resolving');
  assert.deepEqual(game.view(room.code, s.token).history, []);
  assert.throws(() => act('answer', { word: 'changed' }), /closed/);
  finishCheck([true, false]);
  await room.pending;
  const result = room.history.at(-1);
  assert.equal(result.humanCorrect, true);
  assert.equal(result.win, true);
  assert.deepEqual(result.answers.map(a => a.correct), [true, false]);
  assert.equal(result.guessHistory[0].correct, true);
  assert.deepEqual(result.guessHistory.filter(entry => entry.final).map(entry => entry.correct), [true, false]);
  assert.equal(result.nextDifficulty, 6);
  assert.equal(checks, 1);
});

test('solo referee failure is unscored and preserves difficulty', async t => {
  const game = new Game({ soloPace: 60_000, wordGenerator: async () => 'õhuniisutaja',
    soloPlayer: async turn => ({ message: turn.final ? '' : 'Üks vihje.', guess: 'õhuniisutaja' }),
    answerJudge: async () => { throw new Error('Unavailable'); },
  });
  const s = game.create('You', { mode: 'solo' }), room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  game.action({ action: 'start', code: room.code }, s.token);
  await until(() => room.messages.length === 1);
  game.action({ action: 'answer', code: room.code, word: 'õhuniisuti' }, s.token);
  await room.pending;
  assert.equal(room.phase, 'results');
  assert.equal(room.history[0].humanCorrect, null);
  assert.equal(room.history[0].win, null);
  assert.equal(room.difficulty, 5);
});

for (const observerCorrect of [false, true]) {
  test(`multiplayer accepts a human synonym and applies equivalent observer guesses fairly (${observerCorrect})`, async () => {
    let observerLocked = false;
    const game = new Game({ wordGenerator: async () => 'umbrella',
      observer: async input => {
        assert.deepEqual(input.transcript, [{ speaker: 'Ada', text: 'On a rainy day.' }]);
        observerLocked = true;
        return { word: observerCorrect ? 'brolly' : 'pillow', mode: 'openai' };
      },
      answerJudge: async ({ target, guesses }) => {
        assert.equal(observerLocked, true);
        assert.equal(target, 'umbrella');
        return guesses.map(guess => guess === 'brolly');
      },
    });
    const a = game.create('Ada'), b = game.join(a.room.code, 'Bo'), room = game.rooms.get(a.room.code);
    const act = (action, token, extra = {}) => game.action({ action, code: room.code, ...extra }, token);
    act('start', a.token);
    await room.preparation;
    act('message', a.token, { text: 'On a rainy day.' });
    act('answer', b.token, { word: 'brolly' });
    await room.pending;
    assert.equal(room.history[0].answers[0].correct, true);
    assert.equal(room.history[0].aiCorrect, observerCorrect);
    assert.equal(room.history[0].win, !observerCorrect);
    assert.equal(room.difficulty, 6);
  });
}

test('multiplayer referee failure is unscored rather than a false loss', async () => {
  const game = new Game({ wordGenerator: async () => 'umbrella',
    observer: async () => ({ word: 'umbrella', mode: 'openai' }),
    answerJudge: async () => { throw new Error('Unavailable'); },
  });
  const a = game.create('Ada'), b = game.join(a.room.code, 'Bo'), room = game.rooms.get(a.room.code);
  game.action({ action: 'start', code: room.code }, a.token);
  await room.preparation;
  game.action({ action: 'answer', code: room.code, word: 'brolly' }, b.token);
  await room.pending;
  assert.equal(room.history[0].win, null);
  assert.equal(room.history[0].answers[0].correct, null);
  assert.equal(room.history[0].aiCorrect, true);
  assert.equal(room.difficulty, 5);
});
