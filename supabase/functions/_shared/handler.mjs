import { GameError } from '../../../game.mjs';
import { PersistentGame, publicRoom, reserveJob, computeJob, applyJob } from './engine.mjs';

export function createHandler({ store, providers, allowedOrigins = '*', waitUntil = promise => void promise }) {
  const origins = allowedOrigins.split(',').map(value => value.trim());
  async function work(snapshot, job) {
    try {
      const currentProviders = { ...providers };
      if (job.kind === 'word') {
        currentProviders.recentWords = await store.recentWords();
        await store.clearAudio(snapshot.code, snapshot.round - 1).catch(() => {});
      }
      const patch = await computeJob(structuredClone(snapshot), job, currentProviders, store, AbortSignal.timeout(100_000));
      const saved = await store.mutate(snapshot.code, room => applyJob(room, job, patch));
      if (saved.result && job.kind === 'word' && patch.word) await store.rememberWord(patch.word);
    } catch {
      // The lease expires after two minutes; a later poll can safely retry after worker loss.
      console.error('Room worker did not complete. Its lease will be retried.');
    }
  }
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = !origin || origins.includes('*') || origins.includes(origin);
    const headers = {
      'Access-Control-Allow-Origin': origins.includes('*') ? '*' : allowed && origin ? origin : origins[0],
      'Access-Control-Allow-Headers': 'content-type, x-player-token, apikey, authorization, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400', Vary: 'Origin',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    };
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { ...headers, 'Content-Type': 'application/json' },
    });
    if (!allowed) return json({ error: 'Invalid origin.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const url = new URL(request.url);
      const token = request.headers.get('x-player-token');
      const route = url.pathname.split('/').filter(Boolean).at(-1);
      if (route === 'audio') {
        if (request.method !== 'GET') throw new GameError('Method not allowed.', 405);
        const { state } = await store.get(codeOf(url.searchParams.get('code')));
        const engine = new PersistentGame(providers);
        engine.authenticate(state, token);
        const message = state.messages.find(m => m.id === url.searchParams.get('message') && m.audio);
        if (!message) throw new GameError('Audio not found.', 404);
        const audio = await store.audio(`${state.code}/${message.audioRound}/${message.id}.mp3`);
        return new Response(audio, { headers: { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' } });
      }
      if (route !== 'game') throw new GameError('Not found.', 404);
      if (!['GET', 'POST'].includes(request.method)) throw new GameError('Method not allowed.', 405);
      const body = request.method === 'POST' ? await readBody(request) : null;
      if (body?.action === 'create') {
        if (store.allowCreate && !await store.allowCreate(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown')) {
          throw new GameError('Too many new rooms. Try again later.', 429);
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const engine = new PersistentGame(providers);
          const session = engine.action(body, token);
          if (await store.create(engine.rooms.get(session.room.code))) return json(session);
        }
        throw new GameError('Could not create a room. Please retry.', 503);
      }
      const code = codeOf(body?.code || url.searchParams.get('code'));
      const saved = await store.mutate(code, room => {
        const engine = new PersistentGame(providers);
        engine.rooms.set(code, room);
        let session;
        if (body) {
          const value = engine.action(body, token);
          if (body.action === 'join') session = value;
        } else engine.view(code, token);
        const player = engine.authenticate(room, session?.token || token);
        const job = reserveJob(room);
        const view = publicRoom(room, player.id);
        return { value: session ? { ...session, room: view } : view, job };
      });
      if (saved.result.job) waitUntil(work(saved.room, saved.result.job));
      return json(saved.result.value);
    } catch (error) {
      return json({ error: error instanceof GameError ? error.message : 'Something went wrong. Please retry.' }, error.status || 500);
    }
  };
}

function codeOf(value) { return String(value || '').trim().toUpperCase(); }

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new GameError('Invalid JSON.');
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new GameError('Request too large.', 413); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new GameError('Invalid JSON.'); }
}
