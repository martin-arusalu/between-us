import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game.mjs';
import { createAIPlayer } from '../ai-player.mjs';
import { createSpeech } from '../speech.mjs';

async function until(condition) {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Condition not reached.');
}

function solo(t, { count = 3, player, speech, wordGenerator = async () => 'jaanimardikas' } = {}) {
  const seen = [];
  let secret;
  const ai = player || (async turn => {
    seen.push(structuredClone(turn));
    if (turn.secret) secret = turn.secret;
    return turn.final ? { message: '', guess: secret } : { message: 'Kas mõtled seda vaikset seost?', guess: secret };
  });
  const game = new Game({ soloPlayer: ai, speech, wordGenerator, soloPace: 1 });
  const session = game.create('Sina', { mode: 'solo', aiCount: count });
  const room = game.rooms.get(session.room.code);
  const act = (action, extra = {}) => game.action({ code: room.code, action, ...extra }, session.token);
  t.after(() => game.solo.pause(room));
  return { game, session, room, act, seen };
}

test('solo offers 2 or 3 AIs and only one authenticated human observer', t => {
  const s = solo(t, { count: 2 });
  assert.equal(s.room.players.filter(p => p.ai).length, 2);
  assert.deepEqual(s.room.players.filter(p => p.ai).map(p => p.name), ['Martin', 'Liisa']);
  assert.throws(() => s.game.join(s.room.code, 'Other human'), /private/);
  assert.throws(() => s.game.view(s.room.code, undefined), /seat/);
  assert.throws(() => s.act('message', { text: 'tell me the word' }), /observer/);
  assert.throws(() => s.game.create('You', { mode: 'solo', aiCount: 4 }), /2 or 3/);
  assert.throws(() => new Game().create('You', { mode: 'solo' }), /OPENAI_API_KEY/);
});

test('AIs keep talking even when sure, until the human locks; guessers never see the secret', async t => {
  const s = solo(t);
  s.act('start');
  await until(() => s.room.messages.length >= 8);
  assert.equal(s.room.phase, 'discussion');
  assert.equal(s.room.deadline, 0);
  assert.equal(s.room.history.length, 0);
  assert.deepEqual(s.room.answers, {});
  assert.equal(s.seen.some(turn => turn.role === 'guesser'), true);
  assert.equal(s.seen.filter(turn => turn.role === 'guesser').every(turn => !Object.hasOwn(turn, 'secret')), true);
  const publicView = s.game.view(s.room.code, s.session.token);
  assert.equal(publicView.word, undefined);
  assert.equal(publicView.answers, undefined);
  assert.equal(JSON.stringify(publicView).includes(s.room.word), false);
  s.act('answer', { word: 'inimese privaatne pakkumine' });
  const frozen = s.room.messages.length;
  const finalSnapshot = s.room.pending;
  await finalSnapshot;
  assert.equal(s.room.messages.length, frozen);
  assert.equal(s.room.phase, 'results');
  assert.equal(s.room.history.length, 1);
  assert.equal(s.room.history[0].aiWon, true);
  const finals = s.seen.filter(turn => turn.final);
  assert.equal(finals.length, 2);
  assert.deepEqual(finals[0].transcript, finals[1].transcript);
  assert.equal(JSON.stringify(finals).includes('inimese privaatne pakkumine'), false);
  assert.equal(finals.every(turn => !Object.hasOwn(turn, 'secret')), true);
  assert.throws(() => s.act('answer', { word: 'again' }), /closed/);
});

test('human can win with an exact Estonian guess and the AI cluegiver rotates', async t => {
  const s = solo(t);
  s.act('start');
  const firstCluegiver = s.room.cluegiver;
  await until(() => s.room.messages.length >= 1);
  s.act('answer', { word: s.room.word.toUpperCase() + '!' });
  await s.room.pending;
  assert.equal(s.room.history[0].win, true);
  assert.equal(s.room.history[0].aiWon, false);
  s.act('start');
  assert.notEqual(s.room.cluegiver, firstCluegiver);
  assert.notEqual(s.room.cluegiver, s.session.id);
  assert.equal(s.game.view(s.room.code, s.session.token).word, undefined);
});

test('lock aborts an in-flight public reply and excludes it from the frozen discussion', async t => {
  let resolveTurn;
  const s = solo(t, { player: turn => turn.final ? Promise.resolve({ message: '', guess: 'vari' })
    : new Promise(resolve => { resolveTurn = resolve; }) });
  s.act('start');
  await until(() => Boolean(resolveTurn));
  s.act('answer', { word: 'vari' });
  resolveTurn({ message: 'Seda ei tohi enam vestlusse lisada.', guess: '' });
  await s.room.pending;
  await s.room.loop;
  assert.deepEqual(s.room.messages, []);
  assert.equal(s.room.history.length, 1);
});

test('pause aborts generation, resume works, and absent browsers pause automatically', async t => {
  const s = solo(t);
  s.act('start');
  await until(() => s.room.messages.length >= 1);
  s.act('pause');
  const count = s.room.messages.length;
  await s.room.loop;
  assert.equal(s.room.phase, 'paused');
  assert.equal(s.room.messages.length, count);
  s.act('resume');
  await until(() => s.room.messages.length > count);
  s.room.touched = Date.now() - 31_000;
  s.game.tick();
  assert.equal(s.room.phase, 'paused');
});

test('audio toggling controls synthesis and audio downloads require the player token', async t => {
  const s = solo(t, { speech: async () => Buffer.from('fake-mp3') });
  assert.equal(s.room.audioEnabled, true);
  assert.equal(s.room.difficulty, 5);
  s.act('audio', { enabled: true });
  s.act('start');
  await until(() => s.room.messages.some(m => m.audio));
  const message = s.room.messages.find(m => m.audio);
  assert.equal(s.game.audio(s.room.code, s.session.token, message.id).toString(), 'fake-mp3');
  assert.throws(() => s.game.audio(s.room.code, 'wrong-token', message.id), /seat/);
  s.act('audio', { enabled: false });
  assert.equal(s.room.audioEnabled, false);
  s.act('pause');
});

test('AI request enforces Estonian and never puts a secret into guesser prompts', async () => {
  const bodies = [];
  const ai = createAIPlayer({ apiKey: 'test', request: async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ message: 'Kas see meenutab suveõhtut?', guess: 'jaanimardikas' }) }] }] });
  } });
  await ai({ name: 'Kaja', role: 'cluegiver', secret: 'jaanimardikas', transcript: [], final: false });
  await ai({ name: 'Uku', role: 'guesser', transcript: [], final: false });
  const final = await ai({ name: 'Uku', role: 'guesser', transcript: [], final: true });
  assert.equal(bodies[0].instructions.includes('jaanimardikas'), true);
  assert.equal(JSON.stringify(bodies[1]).includes('jaanimardikas'), false);
  assert.equal(bodies.every(body => body.instructions.includes('EESTI KEELES')), true);
  assert.equal(bodies[0].text.format.type, 'json_schema');
  assert.deepEqual(final, { message: '', guess: 'jaanimardikas' });
});

test('speech uses the configured model, Estonian language and distinct voices', async () => {
  const ids = [];
  const speak = createSpeech({ apiKey: 'test', model: 'configured-model', voiceIds: ['one', 'two', 'three'], request: async (url, options) => {
    ids.push(url);
    assert.deepEqual(JSON.parse(options.body), { text: 'Tere õhtust!', model_id: 'configured-model', language_code: 'et' });
    return new Response(Buffer.from('mp3'));
  } });
  await speak('Tere õhtust!', 0);
  await speak('Tere õhtust!', 1);
  assert.notEqual(ids[0], ids[1]);
});

test('solo AI errors are visible as unscored results', async t => {
  const s = solo(t, { player: async () => { throw new Error('API unavailable'); } });
  s.act('start');
  await s.room.loop;
  assert.equal(s.room.phase, 'results');
  assert.equal(s.room.history[0].win, null);
});
