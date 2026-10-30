import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game.mjs';
import { createAIPlayer } from '../ai-player.mjs';
import { createWordGenerator } from '../word-generator.mjs';

const output = data => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });
async function until(condition) {
  for (let i = 0; i < 250; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for test condition.');
}

test('private guesses always use the smaller model; conversation never supplies the answer', async () => {
  const bodies = [];
  const ai = createAIPlayer({ apiKey: 'mock', model: 'dialogue-model', guesserModel: 'small-guesser', request: async (_, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return output(body.model === 'small-guesser'
      ? { message: '', guess: 'kohmetus' }
      : { message: 'Kas see juhtub pigem seltskonnas?', guess: 'IGNORE-THIS-STRONG-MODEL-GUESS' });
  } });
  const transcript = [{ speaker: 'Martin', text: 'Sellises olukorras ei leia alati õigeid sõnu.' }];
  const reply = await ai({ name: 'Liisa', role: 'guesser', transcript, final: false });
  assert.equal(reply.message, 'Kas see juhtub pigem seltskonnas?');
  assert.equal(reply.guess, 'kohmetus');
  assert.deepEqual(bodies.map(b => b.model).sort(), ['dialogue-model', 'small-guesser']);
  assert.equal(bodies.every(b => JSON.stringify(JSON.parse(b.input)) === JSON.stringify({ transcript })), true);
  const final = await ai({ name: 'Liisa', role: 'guesser', transcript, final: true });
  assert.equal(bodies.at(-1).model, 'small-guesser');
  assert.equal(final.guess, 'kohmetus');
  await ai({ name: 'Martin', role: 'cluegiver', secret: 'kohmetus', transcript, final: false });
  assert.equal(bodies.at(-1).model, 'dialogue-model');
});

test('generator is one isolated request with no player or conversation context and no word pool', async () => {
  let calls = 0;
  const generate = createWordGenerator({ apiKey: 'mock', model: 'word-model', request: async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'word-model');
    assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.conversation, undefined);
    const input = JSON.parse(body.input);
    assert.deepEqual(input.exclude, ['järeleandmine']);
    assert.equal(typeof input.nonce, 'string');
    assert.equal(input.transcript, undefined);
    assert.equal(input.players, undefined);
    assert.equal(body.instructions.includes('Language: Estonian'), true);
    assert.equal(body.instructions.includes('human familiarity over rarity'), true);
    assert.deepEqual(Object.keys(input).sort(), ['exclude', 'nonce']);
    return output({ words: Array(12).fill(' Kõhklus ') });
  } });
  assert.equal(await generate({ language: 'et', difficulty: 'challenging', exclude: ['järeleandmine'] }), 'kõhklus');
  assert.equal(calls, 1);
});

test('generator rejects repeats and phrases instead of selecting a fallback word', async () => {
  for (const word of ['vana sõna', 'kohmetus', '', 'ABC123']) {
    const generate = createWordGenerator({ apiKey: 'mock', request: async () => output({ words: Array(12).fill(word) }) });
    await assert.rejects(generate({ language: 'et', exclude: ['kohmetus'] }), /new single word/);
  }
});

const variedWords = ['kastekann', 'sõrmkübar', 'jalgratas', 'kohvitass', 'tolmuimeja', 'vihmavari',
  'lumehelves', 'pannkook', 'laualamp', 'seljakott', 'päästevest', 'kompass'];

test('the server samples the shortlist and avoids recent picks across new rooms', async () => {
  const bodies = [];
  const generate = createWordGenerator({ apiKey: 'mock', pick: max => max - 1, request: async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return output({ words: variedWords });
  } });
  assert.equal(await generate({}), 'kompass');
  assert.equal(await generate({}), 'päästevest');
  assert.deepEqual(JSON.parse(bodies[1].input).exclude, ['kompass']);
  assert.equal(JSON.parse(bodies[1].input).exclude.includes('kastekann'), false, 'Unselected candidates are not treated as played words.');
  assert.equal(bodies.every(body => body.text.format.name === 'secret_word_candidates'), true);
});

test('every batch gets a fresh nonce without category, letter or topic restrictions', async () => {
  const inputs = [];
  const generate = createWordGenerator({ apiKey: 'mock', request: async (_, options) => {
    inputs.push(JSON.parse(JSON.parse(options.body).input));
    return output({ words: variedWords });
  } });
  const selected = [];
  for (let round = 0; round < 8; round++) selected.push(await generate({}));
  assert.equal(inputs.every(input => Object.keys(input).sort().join(',') === 'exclude,nonce'), true);
  assert.equal(new Set(inputs.map(input => input.nonce)).size, 8);
  assert.equal(new Set(selected).size, 8);
});

test('concurrent rounds cannot choose the same word from identical in-flight batches', async () => {
  const releases = [];
  const generate = createWordGenerator({ apiKey: 'mock', pick: () => 0,
    request: () => new Promise(resolve => releases.push(() => resolve(output({ words: variedWords })))),
  });
  const first = generate({}), second = generate({});
  assert.equal(releases.length, 2);
  releases.forEach(release => release());
  assert.deepEqual(await Promise.all([first, second]), ['kastekann', 'sõrmkübar']);
});

test('an all-repeated batch retries once with a fresh nonce instead of recycling a target', async () => {
  const inputs = [];
  const generate = createWordGenerator({ apiKey: 'mock', request: async (_, options) => {
    inputs.push(JSON.parse(JSON.parse(options.body).input));
    return output({ words: Array(12).fill(inputs.length === 1 ? 'VIHMAVARI' : 'seljakott') });
  } });
  assert.equal(await generate({ exclude: [' vihmavari '] }), 'seljakott');
  assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0].nonce, inputs[1].nonce);
});

test('cancelled generation does not reserve a word or leak it into another round', async () => {
  let release;
  let first = true;
  const generate = createWordGenerator({ apiKey: 'mock', request: async () => {
    if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
    return output({ words: Array(12).fill('seljakott') });
  } });
  const controller = new AbortController();
  const pending = generate({}, controller.signal);
  controller.abort();
  release(output({ words: Array(12).fill('seljakott') }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await generate({}), 'seljakott');
});

test('round waits for independent generation before giving a word to the cluegiver', async t => {
  let releaseWord;
  const seen = [];
  const game = new Game({ soloPace: 1,
    wordGenerator: () => new Promise(resolve => { releaseWord = resolve; }),
    soloPlayer: async turn => { seen.push(turn); return { message: 'Tavaline katsevestlus.', guess: 'muu' }; },
  });
  const s = game.create('You', { mode: 'solo' });
  const room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  game.action({ action: 'start', code: room.code }, s.token);
  assert.equal(room.phase, 'preparing');
  assert.equal(seen.length, 0);
  assert.equal(game.view(room.code, s.token).word, undefined);
  releaseWord('kohmetus');
  await until(() => seen.some(turn => turn.role === 'guesser'));
  assert.equal(seen.find(turn => turn.role === 'cluegiver').secret, 'kohmetus');
  assert.equal(seen.filter(turn => turn.role === 'guesser').every(turn => !Object.hasOwn(turn, 'secret')), true);
});

test('word generation failure returns to lobby with no hardcoded fallback or scored round', async t => {
  const game = new Game({ wordGenerator: async () => { throw new Error('Provider down'); }, soloPlayer: async () => {
    assert.fail('No player request may run before a word is generated.');
  } });
  const s = game.create('You', { mode: 'solo' }), room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  game.action({ action: 'start', code: room.code }, s.token);
  await room.loop;
  assert.equal(room.phase, 'lobby');
  assert.equal(room.word, '');
  assert.equal(room.round, 0);
  assert.equal(room.history.length, 0);
  assert.equal(Boolean(room.wordError), true);
});

test('private timeline is committed per published guesser turn and appears only after reveal', async t => {
  let attempts = 0;
  const seen = [];
  const game = new Game({ soloPace: 1, wordGenerator: async () => 'kohmetus', soloPlayer: async turn => {
    seen.push(structuredClone(turn));
    if (turn.role === 'cluegiver') return { message: 'See on üks tuttav tunne.', guess: '' };
    return { message: turn.final ? '' : 'Kas teiste juuresolek teeb asja hullemaks?', guess: ++attempts === 1 ? 'ärevus' : 'kohmetus' };
  } });
  const s = game.create('You', { mode: 'solo', aiCount: 2 }), room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  const act = (action, extra = {}) => game.action({ action, code: room.code, ...extra }, s.token);
  act('start');
  await until(() => room.guessHistory.length >= 2);
  act('pause');
  const view = game.view(room.code, s.token);
  assert.equal(view.guessHistory, undefined);
  assert.equal(JSON.stringify(view).includes('ärevus'), false);
  assert.equal(JSON.stringify(room.messages).includes('ärevus'), false);
  assert.equal(seen.every(turn => !Object.hasOwn(turn, 'guessHistory')), true);
  assert.equal(seen.every(turn => JSON.stringify(turn.transcript).includes('ärevus') === false), true);
  act('answer', { word: 'inimese-salajane-pakkumine' });
  await room.pending;
  const revealed = game.view(room.code, s.token).history.at(-1).guessHistory;
  assert.deepEqual(revealed.slice(0, 2).map(g => [g.guess, g.afterMessage, g.correct]), [['ärevus', 1, false], ['kohmetus', 3, true]]);
  assert.equal(revealed.at(-1).final, true);
  assert.equal(seen.filter(t => t.final).every(t => JSON.stringify(t).includes('inimese-salajane-pakkumine') === false), true);
  act('start');
  assert.deepEqual(room.guessHistory, []);
  assert.equal(room.history[0].guessHistory.length, revealed.length);
});

test('aborted guesser replies do not enter the revealed timeline', async t => {
  let release;
  const game = new Game({ soloPace: 1, wordGenerator: async () => 'kohmetus', soloPlayer: turn => {
    if (turn.final) return Promise.resolve({ message: '', guess: 'kohmetus' });
    if (turn.role === 'cluegiver') return Promise.resolve({ message: 'Üks tuttav tunne.', guess: '' });
    return new Promise(resolve => { release = resolve; });
  } });
  const s = game.create('You', { mode: 'solo' }), room = game.rooms.get(s.room.code);
  t.after(() => game.solo.pause(room));
  game.action({ action: 'start', code: room.code }, s.token);
  await until(() => Boolean(release));
  game.action({ action: 'answer', code: room.code, word: 'kohmetus' }, s.token);
  release({ message: 'See ei tohi avalduda.', guess: 'katkestatud-pakkumine' });
  await room.pending;
  await room.loop;
  assert.equal(room.history.at(-1).guessHistory.some(g => g.guess === 'katkestatud-pakkumine'), false);
});
