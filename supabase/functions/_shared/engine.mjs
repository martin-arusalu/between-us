import { randomUUID } from 'node:crypto';
import { Game, publicRoom, result } from '../../../game.mjs';
import { checkAnswers } from '../../../answer-judge.mjs';

// Use the same rules as Node, but never start a loop or keep a timer in an Edge worker.
export class PersistentGame extends Game {
  constructor(options = {}) {
    super(options);
    this.solo.start = room => {
      const bots = room.players.filter(p => p.ai);
      room.cluegiver = bots[room.round % bots.length].id;
      room.round++;
      Object.assign(room, { word: '', wordError: '', messages: [], answers: {}, guessHistory: [],
        deadline: 0, turn: 0, voiceError: '', speaking: '', aiStatus: '', nextTurn: 0 });
      this.solo.resume(room);
    };
    this.solo.resume = room => {
      invalidate(room);
      room.phase = room.word ? 'discussion' : 'preparing';
      room.nextTurn = 0;
    };
    this.solo.pause = room => {
      invalidate(room);
      room.phase = 'paused';
      room.speaking = '';
      room.aiStatus = '';
    };
    this.solo.lock = (room, word) => {
      room.answers[room.host] = word;
      this.resolve(room);
    };
  }

  prepare(room) { invalidate(room); }
  resolve(room) {
    invalidate(room);
    room.phase = 'resolving';
    room.speaking = '';
    room.aiStatus = '';
  }
}

function invalidate(room) { delete room.job; }

export function reserveJob(room, now = Date.now()) {
  if (room.job?.until > now) return null;
  let kind;
  if (room.phase === 'preparing') kind = 'word';
  else if (room.phase === 'resolving') kind = 'result';
  else if (room.mode === 'solo' && room.phase === 'discussion' && (room.nextTurn || 0) <= now) kind = 'turn';
  if (!kind) return null;
  const job = { id: randomUUID(), kind, until: now + 120_000 };
  room.job = job;
  if (kind === 'turn') {
    room.speaking = nextActor(room).id;
    room.aiStatus = 'thinking';
  }
  return job;
}

function nextActor(room) {
  const bots = room.players.filter(p => p.ai);
  const guessers = bots.filter(p => p.id !== room.cluegiver);
  return room.turn % 2 === 0 ? bots.find(p => p.id === room.cluegiver)
    : guessers[Math.floor(room.turn / 2) % guessers.length];
}

export async function computeJob(room, job, providers, storage, signal) {
  const engine = new PersistentGame(providers);
  if (job.kind === 'word') {
    try {
      room.word = await providers.wordGenerator({ language: room.mode === 'solo' ? 'et' : 'en',
        difficulty: room.difficulty, exclude: [...room.history.map(r => r.word), ...(providers.recentWords || [])] }, signal);
      room.phase = 'discussion';
      room.deadline = room.mode === 'solo' ? 0 : Date.now() + 120_000;
      room.nextTurn = 0;
    } catch {
      room.wordError = 'Could not generate a word. Try again.';
      room.round--;
      room.phase = 'lobby';
    }
    return pick(room, ['word', 'phase', 'deadline', 'nextTurn', 'wordError', 'round']);
  }
  if (job.kind === 'turn') {
    try {
      const actor = nextActor(room);
      const reply = await providers.soloPlayer({ name: actor.name,
        role: actor.id === room.cluegiver ? 'cluegiver' : 'guesser',
        ...(actor.id === room.cluegiver ? { secret: room.word } : {}),
        transcript: engine.solo.snapshot(room), final: false }, signal);
      const message = { id: randomUUID(), player: actor.id, text: reply.message, audio: false };
      let duration = 0;
      if (room.audioEnabled && providers.speech) {
        try {
          const audio = await providers.speech(reply.message, room.players.filter(p => p.ai).indexOf(actor), signal);
          await storage.put(`${room.code}/${room.round}/${message.id}.mp3`, audio);
          message.audio = true;
          message.audioRound = room.round;
          duration = audio.length * 8 / 128;
        } catch { room.voiceError = 'Heli loomine ebaõnnestus. Tekstivestlus jätkub.'; }
      }
      if (actor.id !== room.cluegiver) {
        room.guessHistory.push({ player: actor.id, name: actor.name, afterMessage: room.turn,
          guess: reply.guess || '', final: false });
        room.guessHistory = room.guessHistory.slice(-200);
      }
      room.messages.push(message);
      room.messages = room.messages.slice(-200);
      room.turn++;
      room.nextTurn = Date.now() + Math.max(2500, duration + (duration ? 1500 : 0));
      room.aiStatus = message.audio ? 'speaking' : 'reading';
      return pick(room, ['messages', 'guessHistory', 'turn', 'nextTurn', 'aiStatus', 'voiceError']);
    } catch {
      await engine.solo.finish(room, true);
      return pick(room, ['history', 'difficulty', 'phase', 'speaking']);
    }
  }
  if (room.mode === 'solo') {
    try {
      const transcript = engine.solo.snapshot(room);
      // No target word, human answer or private guess history enters a guesser's context.
      const guesses = await Promise.all(room.players.filter(p => p.ai && p.id !== room.cluegiver)
        .map(async p => [p.id, (await providers.soloPlayer({ name: p.name, role: 'guesser', transcript, final: true }, signal)).guess]));
      for (const [id, guess] of guesses) room.answers[id] = guess;
      await engine.solo.finish(room);
    } catch { await engine.solo.finish(room, true); }
  } else {
    let guess;
    try {
      guess = await providers.observer({ cluegiver: room.players.find(p => p.id === room.cluegiver)?.name,
        transcript: engine.solo.snapshot(room) });
    } catch { guess = { word: null, mode: 'unavailable' }; }
    const words = room.players.filter(p => p.id !== room.cluegiver).map(p => room.answers[p.id] || '');
    const checked = await checkAnswers(room.word, [...words, guess.word || ''], guess.word === null ? null : providers.answerJudge);
    const finished = result(room, guess.word, guess.mode, checked);
    room.history.push(finished);
    room.difficulty = finished.nextDifficulty;
    room.phase = 'results';
  }
  return pick(room, ['answers', 'history', 'difficulty', 'phase', 'speaking']);
}

function pick(room, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(room, key)).map(key => [key, room[key]]));
}

// A pause, lock-in, new round or expired lease makes an old worker's result inapplicable.
export function applyJob(room, job, patch) {
  if (room.job?.id !== job.id) return false;
  Object.assign(room, patch);
  delete room.job;
  return true;
}

export { publicRoom };
