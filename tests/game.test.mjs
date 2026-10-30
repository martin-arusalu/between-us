import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, normalize } from '../game.mjs';
import { createObserver, practiceGuess } from '../observer.mjs';

async function setup(options = {}) {
  let time = 1000;
  let calls = 0;
  let seen;
  let finish;
  const observer = transcript => {
    calls++; seen = transcript;
    return new Promise(resolve => { finish = resolve; });
  };
  const game = new Game({ observer, wordGenerator: async () => 'umbrella', now: () => time, ...options });
  const a = game.create('Ada');
  const b = game.join(a.room.code, 'Bo');
  const c = game.join(a.room.code, 'Cy');
  const command = (action, player = a, extra = {}) => game.action({ action, code: a.room.code, ...extra }, player.token);
  command('start');
  await game.rooms.get(a.room.code).preparation;
  const room = game.rooms.get(a.room.code);
  return { game, a, b, c, command, room, calls: () => calls, seen: () => seen,
    advance: amount => { time += amount; game.tick(); },
    finish: async (word = 'pillow') => { finish({ word, mode: 'openai' }); await room.pending; },
  };
}

test('guessers can lock during discussion; private answers remain hidden', async () => {
  const s = await setup();
  const view = s.command('answer', s.b, { word: s.room.word });
  assert.equal(view.phase, 'discussion');
  assert.equal(view.word, undefined);
  assert.equal(view.answers, undefined);
  assert.equal(view.players.find(p => p.id === s.b.id).locked, true);
  assert.equal(s.calls(), 0);
  assert.throws(() => s.command('answer', s.b, { word: 'changed' }), /already locked/);
  assert.equal(JSON.stringify(view).includes(s.a.token), false);
  assert.equal(s.game.view(s.a.room.code, s.a.token).word, s.room.word);
});

test('last human lock freezes chat and starts exactly one observer automatically', async () => {
  const s = await setup();
  const secret = s.room.word;
  s.command('message', s.a, { text: 'A shared memory.' });
  s.command('answer', s.b, { word: secret });
  s.command('message', s.b, { text: 'I have it.' });
  const view = s.command('answer', s.c, { word: secret });
  assert.equal(view.phase, 'resolving');
  assert.equal(s.calls(), 1);
  assert.equal(view.history.length, 0);
  assert.throws(() => s.command('message', s.a, { text: 'too late' }), /closed/);
  assert.throws(() => s.command('answer', s.c, { word: 'again' }), /closed/);
  s.advance(1_000_000);
  assert.equal(s.calls(), 1);
  assert.deepEqual(Object.keys(s.seen()).sort(), ['cluegiver', 'transcript']);
  assert.equal(JSON.stringify(s.seen()).includes(secret), false);
  const miss = secret === 'pillow' ? 'umbrella' : 'pillow';
  await s.finish(miss);
  assert.equal(s.room.phase, 'results');
  assert.equal(s.room.history[0].win, true);
  assert.equal(s.room.history[0].answers.length, 2);
});

test('timeout starts the observer without polling; missing answers lose', async () => {
  const s = await setup();
  s.command('answer', s.b, { word: s.room.word });
  s.advance(120_000);
  assert.equal(s.room.phase, 'resolving');
  assert.equal(s.calls(), 1);
  assert.throws(() => s.command('answer', s.c, { word: s.room.word }), /closed/);
  await s.finish('a miss');
  assert.equal(s.room.history[0].win, false);
  assert.equal(s.room.history[0].answers[1].word, '');
});

test('two-player round ends as soon as the only guesser locks', async () => {
  let calls = 0;
  const game = new Game({ wordGenerator: async () => 'umbrella', observer: async () => { calls++; return { word: 'wrong', mode: 'openai' }; } });
  const a = game.create('Ada'), b = game.join(a.room.code, 'Bo');
  game.action({ action: 'start', code: a.room.code }, a.token);
  await game.rooms.get(a.room.code).preparation;
  const r = game.view(a.room.code, a.token);
  game.action({ action: 'answer', code: r.code, word: r.word }, b.token);
  const room = game.rooms.get(r.code);
  await room.pending;
  assert.equal(calls, 1);
  assert.equal(room.phase, 'results');
  assert.equal(room.history[0].win, true);
});

test('matching observer defeats the humans; new round rotates cluegiver and clears state', async () => {
  const s = await setup();
  s.command('answer', s.b, { word: s.room.word.toUpperCase() + '!' });
  s.command('answer', s.c, { word: s.room.word });
  await s.finish(s.room.word);
  assert.equal(s.room.history[0].win, false);
  const view = s.command('start');
  assert.equal(view.cluegiver, s.b.id);
  assert.deepEqual(view.messages, []);
  assert.equal(view.players.filter(p => p.locked).length, 1);
  assert.equal(view.history.length, 1);
});

test('observer failure produces an unscored round', async () => {
  const s = await setup({ observer: async () => { throw new Error('API down'); } });
  s.command('answer', s.b, { word: s.room.word });
  s.command('answer', s.c, { word: s.room.word });
  await s.room.pending;
  assert.equal(s.room.history[0].win, null);
  assert.equal(s.room.phase, 'results');
});

test('roles, authentication and locked membership enforced', async () => {
  const s = await setup();
  assert.throws(() => s.game.view(s.room.code, 'invalid'), /seat/);
  assert.throws(() => s.command('start', s.b), /host/);
  assert.throws(() => s.command('answer', s.a, { word: 'umbrella' }), /cluegiver/);
  assert.throws(() => s.game.join(s.room.code, 'New player'), /in progress/);
  assert.throws(() => s.command('remove', s.a, { player: s.b.id }), /between rounds/);
});

test('OpenAI request contains only the supplied public transcript; output is parsed', async () => {
  const transcript = { cluegiver: 'Ada', transcript: [{ speaker: 'Ada', text: 'That rainy day.' }] };
  const observe = createObserver({ apiKey: 'test-key', request: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.input), transcript);
    assert.equal(body.store, false);
    return Response.json({ output: [{ type: 'reasoning' }, { content: [{ type: 'output_text', text: 'umbrella' }] }] });
  } });
  assert.deepEqual(await observe(transcript), { word: 'umbrella', mode: 'openai' });
});

test('practice bot is explicit; literal normalization stays separate from meaning checks', async () => {
  const transcript = { transcript: [{ text: 'It is an umbrella.' }] };
  assert.equal(practiceGuess(transcript).word, 'umbrella');
  assert.equal((await createObserver()(transcript)).mode, 'practice');
  assert.equal(normalize('  UMBRELLA! '), 'umbrella');
  assert.notEqual(normalize('bike'), normalize('bicycle'));
});
