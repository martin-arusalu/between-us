import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Game, GameError } from './game.mjs';
import { createObserver } from './observer.mjs';
import { createAIPlayer } from './ai-player.mjs';
import { createSpeech } from './speech.mjs';
import { createWordGenerator } from './word-generator.mjs';
import { createAnswerJudge } from './answer-judge.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// Native Node .env loading. Existing environment values take precedence.
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const apiKey = process.env.OPENAI_API_KEY?.trim();
const game = new Game({
  observer: createObserver({ apiKey, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' }),
  aiMode: apiKey ? 'openai' : 'practice',
  soloPlayer: createAIPlayer({ apiKey, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    guesserModel: process.env.OPENAI_GUESSER_MODEL || 'gpt-5.4-nano' }),
  wordGenerator: createWordGenerator({ apiKey, model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' }),
  answerJudge: createAnswerJudge({ apiKey }),
  speech: createSpeech({ apiKey: process.env.ELEVENLABS_API_KEY?.trim(),
    model: process.env.ELEVENLABS_MODEL || 'eleven_v3',
    voiceIds: (process.env.ELEVENLABS_VOICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean) }),
});
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/config.js', ['config.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > 4096) throw new GameError('Request too large.', 413);
    parts.push(part);
  }
  try {
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new GameError('Invalid JSON.', 400); }
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/audio' && request.method === 'GET') {
      const audio = game.audio(url.searchParams.get('code'), request.headers['x-player-token'], url.searchParams.get('message'));
      response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'private, max-age=3600' });
      return response.end(audio);
    }
    if (url.pathname === '/api/game') {
      const token = request.headers['x-player-token'];
      if (request.method === 'GET') return json(response, 200, game.view(url.searchParams.get('code'), token));
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed.' });
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        return json(response, 403, { error: 'Invalid origin.' });
      }
      return json(response, 200, game.action(await readBody(request), token));
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
    const asset = assets.get(url.pathname);
    if (!asset) return json(response, 404, { error: 'Not found.' });
    const file = path.join(root, 'public', asset[0]);
    const info = await stat(file);
    response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (!response.headersSent) json(response, error.status || 500, {
      error: error instanceof GameError ? error.message : 'Something went wrong. Please try again.',
    });
    else response.end();
  }
});

const interval = setInterval(() => game.tick(), 250);
interval.unref();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Between Us → http://localhost:${server.address().port}`);
  console.log(apiKey ? `OpenAI observer enabled (${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}).` : 'Practice observer enabled. Add OPENAI_API_KEY to .env for live AI.');
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other server or set PORT in .env.` : 'Could not start the server.');
  process.exitCode = 1;
  clearInterval(interval);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(interval);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
});
