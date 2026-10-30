import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('HTTP server: independent players lock early, reveal automatically, and secrets are not served', async () => {
  const child = spawn(process.execPath, ['--import', './tests/mock-openai.mjs', 'server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', OPENAI_API_KEY: 'mock-key', ELEVENLABS_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let log = '';
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start.')), 5000);
      child.stdout.on('data', chunk => {
        log += chunk;
        const match = log.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    });
    const post = async (body, token) => {
      const res = await fetch(base + '/api/game', { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(token ? { 'x-player-token': token } : {}),
      }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/server.mjs')).status, 404);
    const a = (await post({ action: 'create', name: 'Ada' })).data;
    const b = (await post({ action: 'join', name: 'Bo', code: a.room.code })).data;
    await post({ action: 'start', code: a.room.code }, a.token);
    let started;
    for (let i = 0; i < 30; i++) {
      started = await (await fetch(base + '/api/game?code=' + a.room.code, { headers: { 'x-player-token': a.token } })).json();
      if (started.phase === 'discussion') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(started.phase, 'discussion');
    const before = await fetch(base + '/api/game?code=' + a.room.code, { headers: { 'x-player-token': b.token } });
    assert.equal((await before.json()).word, undefined);
    assert.equal((await post({ action: 'message', code: a.room.code, text: 'A tiny shared clue.' }, a.token)).status, 200);
    const locked = await post({ action: 'answer', code: a.room.code, word: 'brolly' }, b.token);
    assert.equal(locked.status, 200);
    let revealed;
    for (let i = 0; i < 20; i++) {
      revealed = await (await fetch(base + '/api/game?code=' + a.room.code, { headers: { 'x-player-token': b.token } })).json();
      if (revealed.phase === 'results') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(revealed.phase, 'results');
    assert.equal(revealed.history[0].word, started.word);
    assert.equal(revealed.history[0].answers[0].word, 'brolly');
    assert.equal(revealed.history[0].answers[0].correct, true);
    assert.equal(revealed.history[0].aiCorrect, false);
    assert.equal(revealed.history[0].win, true);
    const foreign = await fetch(base + '/api/game', { method: 'POST', headers: { origin: 'http://elsewhere.test' }, body: '{}' });
    assert.equal(foreign.status, 403);
    const next = await post({ action: 'start', code: a.room.code }, a.token);
    assert.equal(next.data.cluegiver, b.id);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
