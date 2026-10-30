import { randomInt, randomUUID } from 'node:crypto';
import { SoloRounds } from './solo.mjs';
import { difficultyLevel, nextDifficulty } from './difficulty.mjs';
import { normalize, checkAnswers } from './answer-judge.mjs';
export { normalize } from './answer-judge.mjs';

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireThat(condition, message, status = 400) {
  if (!condition) throw new GameError(message, status);
}

function playerName(value) {
  const name = String(value || '').trim().slice(0, 24);
  requireThat(name, 'Enter your name.');
  return name;
}

export function publicRoom(room, id) {
  return {
    code: room.code,
    mode: room.mode || 'multiplayer',
    difficulty: difficultyLevel(room.difficulty) || 5,
    wordError: room.wordError || '',
    wordReady: Boolean(room.word),
    audioEnabled: Boolean(room.audioEnabled),
    voiceAvailable: Boolean(room.voiceAvailable),
    voiceError: room.voiceError || '',
    speaking: room.speaking || '',
    aiStatus: room.aiStatus || '',
    host: room.host,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      ai: Boolean(player.ai),
      locked: player.id === room.cluegiver || Object.hasOwn(room.answers, player.id),
    })),
    phase: room.phase,
    round: room.round,
    cluegiver: room.cluegiver,
    word: room.cluegiver === id ? room.word : undefined,
    messages: room.messages.map(message => ({ ...message })),
    deadline: room.deadline,
    history: structuredClone(room.history),
    aiMode: room.aiMode,
  };
}

export function result(room, ai, mode, checked) {
  const answers = room.players.filter(p => p.id !== room.cluegiver).map((p, index) => ({
    name: p.name,
    word: room.answers[p.id] || '',
    correct: checked ? checked.matches[index] : normalize(room.answers[p.id]) === normalize(room.word),
  }));
  const humansMatch = answers.every(answer => answer.correct);
  const aiMatches = ai === null ? null : checked ? checked.matches.at(-1) : normalize(ai) === normalize(room.word);
  const unscored = ai === null || checked?.failed;
  const difficulty = difficultyLevel(room.difficulty) || 5;
  const next = nextDifficulty(difficulty, { humanCorrect: answers.some(a => a.correct), aiCorrect: aiMatches, scored: !unscored });
  return {
    round: room.round, word: room.word, ai, aiCorrect: aiMatches, mode, answers, difficulty, nextDifficulty: next,
    win: unscored ? null : humansMatch && !aiMatches,
    reason: checked?.failed ? 'Answer checking failed. This round is unscored.'
      : ai === null ? 'The observer couldn’t make a guess. This round is unscored.'
      : !humansMatch ? 'The humans didn’t all find the word.'
      : aiMatches ? 'The observer found it too.'
      : 'You understood each other. The observer didn’t.',
  };
}

// All room state lives here. A restart starts fresh.
export class Game {
  constructor({ observer, aiMode = 'practice', duration = 120_000, now = Date.now, soloPlayer, speech, wordGenerator, answerJudge, soloPace = 2500 } = {}) {
    this.rooms = new Map();
    this.observer = observer;
    this.aiMode = aiMode;
    this.duration = duration;
    this.now = now;
    this.wordGenerator = wordGenerator;
    this.answerJudge = answerJudge;
    this.solo = new SoloRounds({ player: soloPlayer, speech, wordGenerator, answerJudge, now, pace: soloPace });
  }

  create(name, { mode = 'multiplayer', aiCount = 2, difficulty = 5 } = {}) {
    requireThat(['multiplayer', 'solo'].includes(mode), 'Unknown game mode.');
    difficulty = difficultyLevel(difficulty);
    requireThat(difficulty !== null, 'Word difficulty must be an integer from 1 to 10.');
    if (mode === 'solo') {
      requireThat(this.solo.player && this.wordGenerator, 'Solo mode needs OPENAI_API_KEY in .env.', 503);
      requireThat([2, 3].includes(Number(aiCount)), 'Choose 2 or 3 AI players.');
    }
    requireThat(this.rooms.size < 1000, 'The server is full. Try again later.', 503);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
    while (this.rooms.has(code));
    const player = { id: randomUUID(), token: randomUUID(), name: playerName(name) };
    const room = {
      mode, difficulty, wordError: '', audioEnabled: mode === 'solo' && Boolean(this.solo.speech), voiceAvailable: Boolean(this.solo.speech),
      code, host: player.id, players: [player], phase: 'lobby', round: 0,
      cluegiver: '', word: '', messages: [], answers: {}, deadline: 0,
      history: [], aiMode: this.aiMode, touched: this.now(),
    };
    if (mode === 'solo') {
      for (const name of ['Martin', 'Liisa', 'Rasmus'].slice(0, Number(aiCount))) {
        room.players.push({ id: randomUUID(), token: randomUUID(), name, ai: true });
      }
    }
    this.rooms.set(code, room);
    return this.session(room, player);
  }

  session(room, player) {
    return { id: player.id, token: player.token, room: publicRoom(room, player.id) };
  }

  find(code) {
    const room = this.rooms.get(String(code || '').trim().toUpperCase());
    requireThat(room, 'Room not found. It may have expired or the server restarted.', 404);
    this.expire(room);
    room.touched = this.now();
    return room;
  }

  authenticate(room, token) {
    const player = room.players.find(p => p.token === token);
    requireThat(player, 'Your seat is no longer available. Rejoin the room.', 403);
    return player;
  }

  view(code, token) {
    const room = this.find(code);
    return publicRoom(room, this.authenticate(room, token).id);
  }

  join(code, name, token) {
    const room = this.find(code);
    const existing = room.players.find(player => player.token === token);
    if (existing) return this.session(room, existing);
    requireThat(room.mode !== 'solo', 'Solo rooms are private to their observer.', 403);
    requireThat(['lobby', 'results'].includes(room.phase), 'A round is in progress. Join after the reveal.');
    requireThat(room.players.length < 8, 'This room is full (8 players).');
    name = playerName(name);
    requireThat(!room.players.some(p => p.name.toLowerCase() === name.toLowerCase()), 'That name is already taken.');
    const player = { id: randomUUID(), token: randomUUID(), name };
    room.players.push(player);
    return this.session(room, player);
  }

  action(body, token) {
    if (body.action === 'create') return this.create(body.name, body);
    if (body.action === 'join') return this.join(body.code, body.name, token);
    const room = this.find(body.code);
    const me = this.authenticate(room, token);
    if (room.mode === 'solo') return this.soloAction(room, me, body);
    switch (body.action) {
      case 'start': {
        requireThat(me.id === room.host, 'Only the host can start a round.', 403);
        requireThat(['lobby', 'results'].includes(room.phase), 'A round is already in progress.');
        requireThat(room.players.length >= 2, 'Invite at least one other player.');
        requireThat(room.round < 30, 'This room finished 30 rounds. Create a new room.');
        requireThat(this.wordGenerator, 'Add OPENAI_API_KEY to .env to generate a word.', 503);
        room.cluegiver = room.players[room.round % room.players.length].id;
        room.round++;
        room.word = '';
        room.wordError = '';
        room.messages = [];
        room.answers = {};
        room.deadline = 0;
        room.phase = 'preparing';
        this.prepare(room);
        break;
      }
      case 'message': {
        requireThat(room.phase === 'discussion', 'Chat has closed for this round.');
        const text = String(body.text || '').trim();
        requireThat(text && text.length <= 500, 'Send a message between 1 and 500 characters.');
        requireThat(room.messages.length < 100, 'Chat is full. Lock your answers to finish.');
        room.messages.push({ id: randomUUID(), player: me.id, text });
        break;
      }
      case 'answer': {
        requireThat(room.phase === 'discussion', 'Answers have closed for this round.');
        requireThat(me.id !== room.cluegiver, 'The cluegiver already knows the word.');
        requireThat(!Object.hasOwn(room.answers, me.id), 'Your answer is already locked.');
        const word = String(body.word || '').trim();
        requireThat(word && word.length <= 80, 'Enter a guess between 1 and 80 characters.');
        room.answers[me.id] = word;
        if (room.players.filter(p => p.id !== room.cluegiver).every(p => Object.hasOwn(room.answers, p.id))) {
          this.resolve(room);
        }
        break;
      }
      case 'remove': {
        requireThat(me.id === room.host && ['lobby', 'results'].includes(room.phase),
          'Only the host can remove players between rounds.', 403);
        requireThat(body.player !== room.host, 'The host cannot be removed.');
        room.players = room.players.filter(p => p.id !== body.player);
        break;
      }
      default: throw new GameError('Unknown action.');
    }
    return publicRoom(room, me.id);
  }

  prepare(room) {
    room.controller = new AbortController();
    room.preparation = (async () => {
      try {
        const word = await this.wordGenerator({ language: 'en', difficulty: room.difficulty,
          exclude: room.history.map(round => round.word) }, room.controller.signal);
        if (room.controller.signal.aborted) return;
        room.word = word;
        room.deadline = this.now() + this.duration;
        room.phase = 'discussion';
      } catch {
        room.wordError = 'Could not generate a word. Try starting the round again.';
        room.round--;
        room.phase = 'lobby';
      }
      delete room.preparation;
    })();
  }

  soloAction(room, me, body) {
    requireThat(me.id === room.host, 'Only the observer can control this round.', 403);
    switch (body.action) {
      case 'start':
        requireThat(['lobby', 'results'].includes(room.phase), 'A round is already in progress.');
        requireThat(room.round < 30, 'Create a new room after 30 rounds.');
        this.solo.start(room);
        break;
      case 'answer': {
        requireThat(['discussion', 'paused'].includes(room.phase) && room.word, 'Answers are closed.');
        const word = String(body.word || '').trim();
        requireThat(word && word.length <= 80, 'Enter a guess between 1 and 80 characters.');
        this.solo.lock(room, word);
        break;
      }
      case 'audio':
        requireThat(typeof body.enabled === 'boolean', 'Invalid audio setting.');
        requireThat(room.voiceAvailable || !body.enabled, 'Add ELEVENLABS_API_KEY to .env to enable audio.');
        room.audioEnabled = body.enabled;
        room.voiceError = '';
        if (!body.enabled) room.voiceController?.abort();
        break;
      case 'pause':
        if (['preparing', 'discussion'].includes(room.phase)) this.solo.pause(room);
        break;
      case 'resume':
        requireThat(room.phase === 'paused', 'The round is not paused.');
        this.solo.resume(room);
        break;
      default: throw new GameError('You are the observer. Watch the AI conversation and lock your guess.');
    }
    return publicRoom(room, me.id);
  }

  audio(code, token, message) {
    const room = this.find(code);
    this.authenticate(room, token);
    const audio = room.audioCache?.get(message);
    requireThat(audio, 'Audio not found.', 404);
    return audio;
  }

  expire(room) {
    if (room.mode === 'solo') return this.solo.expire(room);
    if (room.phase === 'discussion' && this.now() >= room.deadline) this.resolve(room);
  }

  resolve(room) {
    // Freeze synchronously before the first await: concurrent answers can trigger only one request.
    if (room.phase !== 'discussion') return;
    room.phase = 'resolving';
    const transcript = {
      cluegiver: room.players.find(p => p.id === room.cluegiver)?.name,
      transcript: room.messages.map(m => ({
        speaker: room.players.find(p => p.id === m.player)?.name,
        text: m.text,
      })),
    };
    // The observer receives this public snapshot, never the secret or private answers.
    room.pending = (async () => {
      let guess;
      try { guess = await this.observer(transcript); }
      catch { guess = { word: null, mode: 'unavailable' }; }
      // The observer has locked its guess before the referee receives any private data.
      const words = room.players.filter(p => p.id !== room.cluegiver).map(p => room.answers[p.id] || '');
      const checked = await checkAnswers(room.word, [...words, guess.word || ''], guess.word === null ? null : this.answerJudge);
      const finished = result(room, guess.word, guess.mode, checked);
      room.history.push(finished);
      room.difficulty = finished.nextDifficulty;
      room.phase = 'results';
      delete room.pending;
    })();
  }

  tick() {
    for (const [code, room] of this.rooms) {
      if (this.now() - room.touched > 12 * 60 * 60 * 1000 && room.phase !== 'resolving') {
        room.controller?.abort();
        this.rooms.delete(code);
      } else {
        this.expire(room);
      }
    }
  }
}
