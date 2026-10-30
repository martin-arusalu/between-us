import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentGame, reserveJob, applyJob } from '../supabase/functions/_shared/engine.mjs';
import { createHandler } from '../supabase/functions/_shared/handler.mjs';
import { RoomStore } from '../supabase/functions/_shared/store.mjs';

function memoryStore() {
  const rows = new Map();
  return {
    rows, words: [],
    async create(room) { if (rows.has(room.code)) return false; rows.set(room.code, { state: structuredClone(room), version: 0 }); return true; },
    async get(code) { const row = rows.get(code); if (!row) throw new Error('Not found'); return structuredClone(row); },
    async swap(state, version) {
      await Promise.resolve(); // Let concurrent requests read the same initial revision.
      if (rows.get(state.code).version !== version) return false;
      rows.set(state.code, { state: structuredClone(state), version: version + 1 }); return true;
    },
    mutate: RoomStore.prototype.mutate,
    async recentWords() { return [...this.words]; },
    async rememberWord(word) { this.words.push(word); },
    async clearAudio() {},
    async put() {},
  };
}
function harness(overrides = {}) {
  const jobs = [];
  const calls = [];
  const store = memoryStore();
  const providers = { aiMode: 'openai', wordGenerator: async () => 'vihmavari',
    soloPlayer: async turn => { calls.push(structuredClone(turn)); return { message: 'Seda kasutan õues.', guess: 'vihmavari' }; },
    observer: async turn => { calls.push(turn); return { word: 'vihmavari', mode: 'openai' }; },
    ...overrides };
  const handler = createHandler({ store, providers, waitUntil: promise => jobs.push(promise), allowedOrigins: 'https://example.github.io' });
  async function send(body, session, method = 'POST') {
    const response = await handler(new Request(`https://test/functions/v1/game${method === 'GET' ? `?code=${session.code}` : ''}`, {
      method, headers: { origin: 'https://example.github.io', 'Content-Type': 'application/json', ...(session ? { 'x-player-token': session.token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ ...body, code: body?.code || session?.code }) } : {}),
    }));
    return { status: response.status, value: await response.json() };
  }
  async function drain() { await Promise.all(jobs.splice(0)); }
  async function create(mode = 'solo') {
    const { value } = await send({ action: 'create', mode, name: 'Sina' });
    return { ...value, code: value.room.code };
  }
  return { store, providers, handler, send, drain, create, calls, jobs };
}

test('Supabase serializes concurrent polls into a single AI turn, with private state filtered', async () => {
  let release;
  let count = 0;
  const h = harness({ soloPlayer: async () => { count++; await new Promise(resolve => { release = resolve; }); return { message: 'Tavaline asi.', guess: '' }; } });
  const session = await h.create();
  await h.send({ action: 'start' }, session);
  await h.drain();
  assert.deepEqual(h.store.words, ['vihmavari']);
  const replies = await Promise.all(Array.from({ length: 8 }, () => h.send(null, session, 'GET')));
  assert.equal(count, 1);
  assert.equal(h.jobs.length, 1);
  for (const { value, status } of replies) {
    assert.equal(status, 200);
    assert.equal(value.word, undefined);
    assert.equal(value.answers, undefined);
    assert.equal(value.job, undefined);
    assert.equal(value.players.some(p => p.token), false);
  }
  release(); await h.drain();
  assert.equal(h.store.rows.get(session.code).state.messages.length, 1);
});

test('Supabase lock-in discards a late public reply and final guessers get only the frozen public transcript', async () => {
  let release;
  const inputs = [];
  const h = harness({ soloPlayer: async turn => {
    inputs.push(structuredClone(turn));
    if (!turn.final) await new Promise(resolve => { release = resolve; });
    return { message: turn.final ? '' : 'Late reply', guess: 'vihmavari' };
  } });
  const session = await h.create();
  await h.send({ action: 'start' }, session); await h.drain();
  await h.send(null, session, 'GET');
  const oldJob = h.jobs.shift();
  const locked = await h.send({ action: 'answer', word: 'vihmavari' }, session);
  assert.equal(locked.value.phase, 'resolving');
  await h.drain();
  release(); await oldJob;
  const state = h.store.rows.get(session.code).state;
  assert.equal(state.phase, 'results');
  assert.deepEqual(state.messages, []);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].humanCorrect, true);
  const final = inputs.find(input => input.final);
  assert.deepEqual(Object.keys(final).sort(), ['final', 'name', 'role', 'transcript']);
  assert.deepEqual(final.transcript, []);
});

test('Supabase pause invalidates the worker lease and a resumed round can retry a lost worker', () => {
  const game = new PersistentGame({ soloPlayer: async () => {}, wordGenerator: async () => 'test' });
  const session = game.create('Sina', { mode: 'solo' });
  const room = game.rooms.get(session.room.code);
  game.action({ action: 'start', code: room.code }, session.token);
  const old = reserveJob(room, 1);
  assert.equal(reserveJob(room, 2), null);
  const replacement = reserveJob(room, 120002);
  assert.notEqual(replacement.id, old.id);
  assert.equal(applyJob(room, old, { word: 'wrong' }), false);
  game.action({ action: 'pause', code: room.code }, session.token);
  assert.equal(applyJob(room, replacement, { phase: 'discussion' }), false);
  assert.equal(room.phase, 'paused');
  game.action({ action: 'resume', code: room.code }, session.token);
  assert.equal(reserveJob(room).kind, 'word');
});

test('Supabase rejects unauthorized seats, disallowed origins and oversized bodies without scheduling work', async () => {
  const h = harness();
  const session = await h.create();
  assert.equal((await h.send({ action: 'start' }, { ...session, token: 'wrong' })).status, 403);
  const denied = await h.handler(new Request('https://test/functions/v1/game', { headers: { origin: 'https://attacker.example' } }));
  assert.equal(denied.status, 403);
  const huge = await h.handler(new Request('https://test/functions/v1/game', { method: 'POST', body: 'x'.repeat(4097) }));
  assert.equal(huge.status, 413);
  assert.equal(h.jobs.length, 0);
});

test('Supabase multiplayer locks all humans before the observer and supports deadline resolution', async () => {
  const h = harness();
  const host = await h.create('multiplayer');
  const { value } = await h.send({ action: 'join', code: host.code, name: 'Friend' });
  const friend = { ...value, code: host.code };
  await h.send({ action: 'start' }, host); await h.drain();
  await h.send({ action: 'message', text: 'Take it when it rains.' }, host);
  const locked = await h.send({ action: 'answer', word: 'vihmavari' }, friend);
  assert.equal(locked.value.phase, 'resolving');
  await h.drain();
  assert.equal(h.store.rows.get(host.code).state.history[0].aiCorrect, true);
  assert.deepEqual(Object.keys(h.calls[0]).sort(), ['cluegiver', 'transcript']);
  await h.send({ action: 'start' }, host); await h.drain();
  h.store.rows.get(host.code).state.deadline = Date.now() - 1;
  await h.send(null, host, 'GET'); await h.drain();
  assert.equal(h.store.rows.get(host.code).state.history.length, 2);
});
