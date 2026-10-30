import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { difficultyLevel, nextDifficulty } from './difficulty.mjs';
import { checkAnswers } from './answer-judge.mjs';

// One independent model request per AI turn. Only the cluegiver receives the word.
export class SoloRounds {
  constructor({ player, speech, wordGenerator, answerJudge, now = Date.now, pace = 2500, idleTimeout = 30_000 } = {}) {
    this.player = player;
    this.wordGenerator = wordGenerator;
    this.answerJudge = answerJudge;
    this.speech = speech;
    this.now = now;
    this.pace = pace;
    this.idleTimeout = idleTimeout;
  }

  start(room) {
    room.controller?.abort();
    const bots = room.players.filter(p => p.ai);
    room.cluegiver = bots[room.round % bots.length].id;
    room.round++;
    room.word = '';
    room.wordError = '';
    room.messages = [];
    room.answers = {};
    room.guessHistory = [];
    room.history = room.history || [];
    room.audioCache = new Map();
    room.deadline = 0; // Solo discussion ends when the human locks, never on an AI's confidence.
    room.turn = 0;
    room.phase = 'discussion';
    room.voiceError = '';
    this.resume(room);
  }

  resume(room) {
    room.phase = room.word ? 'discussion' : 'preparing';
    room.controller = new AbortController();
    const controller = room.controller;
    room.loop = (async () => {
      if (!room.word) {
        try {
          const word = await this.wordGenerator({ language: 'et', difficulty: room.difficulty,
            exclude: room.history.map(round => round.word) }, controller.signal);
          if (controller.signal.aborted || room.controller !== controller || room.phase !== 'preparing') return;
          room.word = word;
          room.phase = 'discussion';
        } catch {
          if (controller.signal.aborted || room.controller !== controller) return;
          room.wordError = 'Salasõna loomine ebaõnnestus. Proovi uuesti.';
          room.round--;
          room.phase = 'lobby';
          return;
        }
      }
      await this.run(room, controller);
    })().catch(() => {
      if (room.controller === controller && room.phase === 'discussion') return this.fail(room);
    });
  }

  snapshot(room) {
    return room.messages.map(m => ({ speaker: room.players.find(p => p.id === m.player)?.name, text: m.text }));
  }

  async run(room, controller) {
    const signal = controller.signal;
    const bots = room.players.filter(p => p.ai);
    const guessers = bots.filter(p => p.id !== room.cluegiver);
    const cluegiver = bots.find(p => p.id === room.cluegiver);
    while (room.phase === 'discussion' && !signal.aborted) {
      const actor = room.turn % 2 === 0 ? cluegiver : guessers[Math.floor(room.turn / 2) % guessers.length];
      room.speaking = actor.id;
      room.aiStatus = 'thinking';
      const turn = await this.player({
        name: actor.name,
        role: actor.id === room.cluegiver ? 'cluegiver' : 'guesser',
        ...(actor.id === room.cluegiver ? { secret: room.word } : {}),
        transcript: this.snapshot(room),
        final: false,
      }, signal);
      if (signal.aborted || room.phase !== 'discussion') return;
      const message = { id: randomUUID(), player: actor.id, text: turn.message, audio: false };
      let audioDuration = 0;
      if (room.audioEnabled && this.speech) {
        room.aiStatus = 'voice';
        room.voiceController = new AbortController();
        try {
          const audio = await this.speech(turn.message, bots.indexOf(actor),
            AbortSignal.any([signal, room.voiceController.signal]));
          if (!signal.aborted && room.audioEnabled) {
            room.audioCache.set(message.id, audio);
            message.audio = true;
            audioDuration = audio.length * 8 / 128; // 128 kbps MP3, duration in milliseconds.
          }
        } catch {
          if (!signal.aborted && room.audioEnabled) room.voiceError = 'Heli loomine ebaõnnestus. Tekstivestlus jätkub.';
        }
      }
      if (signal.aborted || room.phase !== 'discussion') return;
      room.aiStatus = message.audio ? 'speaking' : 'reading';
      // Commit a guess only when its public turn is actually published. Aborted replies leave no entry.
      if (actor.id !== room.cluegiver) {
        room.guessHistory.push({ player: actor.id, name: actor.name, afterMessage: room.turn,
          guess: turn.guess || '', final: false });
        if (room.guessHistory.length > 200) room.guessHistory.shift();
      }
      room.messages.push(message);
      room.turn++;
      // Bound memory for very long sessions without ending the conversation.
      if (room.messages.length > 200) {
        const removed = room.messages.shift();
        room.audioCache.delete(removed.id);
      }
      await delay(Math.max(this.pace, audioDuration + (audioDuration ? 1500 : 0)), undefined, { signal });
    }
  }

  lock(room, word) {
    room.answers[room.host] = word;
    room.phase = 'resolving';
    room.controller?.abort();
    room.voiceController?.abort();
    room.speaking = '';
    // Snapshot once. Every guesser gets the same frozen public discussion, not the human's answer.
    const transcript = this.snapshot(room);
    const guessers = room.players.filter(p => p.ai && p.id !== room.cluegiver);
    room.pending = (async () => {
      try {
        const guesses = await Promise.all(guessers.map(async player => ({
          player,
          reply: await this.player({ name: player.name, role: 'guesser', transcript, final: true }),
        })));
        for (const { player, reply } of guesses) room.answers[player.id] = reply.guess;
        await this.finish(room);
      } catch { await this.fail(room); }
      delete room.pending;
    })();
  }

  async finish(room, failed = false) {
    if (room.phase === 'results') return;
    const humanWord = room.answers[room.host] || '';
    const answers = room.players.filter(p => p.ai && p.id !== room.cluegiver).map(player => ({
      name: player.name, word: room.answers[player.id] || '',
    }));
    const guessHistory = [...room.guessHistory];
    for (const player of room.players.filter(p => p.ai && p.id !== room.cluegiver)) {
      if (Object.hasOwn(room.answers, player.id)) guessHistory.push({
        player: player.id, name: player.name, afterMessage: room.turn,
        guess: room.answers[player.id], final: true,
      });
    }
    // One independent batch applies the same meaning rules to humans, AIs and the revealed timeline.
    const checked = await checkAnswers(room.word,
      [humanWord, ...answers.map(a => a.word), ...guessHistory.map(entry => entry.guess)],
      failed ? null : this.answerJudge);
    if (room.phase === 'results') return;
    failed ||= checked.failed;
    const humanCorrect = checked.matches[0];
    answers.forEach((answer, index) => { answer.correct = checked.matches[index + 1]; });
    const aiWon = !failed && answers.every(a => a.correct === true) && !humanCorrect;
    const difficulty = difficultyLevel(room.difficulty) || 5;
    const next = nextDifficulty(difficulty, { humanCorrect, aiCorrect: answers.some(a => a.correct), scored: !failed });
    room.history.push({
      guessHistory: guessHistory.map((entry, index) => ({ ...entry, correct: checked.matches[1 + answers.length + index] })),
      round: room.round, word: room.word, mode: 'solo', answers, humanWord, humanCorrect,
      aiWon, win: failed ? null : humanCorrect, difficulty, nextDifficulty: next,
      reason: checked.failed ? 'Vastuste kontroll ebaõnnestus. See voor ei lähe arvesse.'
        : failed ? 'AI vastus ebaõnnestus. See voor ei lähe arvesse.'
        : humanCorrect ? 'Said sõnale pihta! Tehisintellektid ei suutnud seda sinu eest varjata.'
        : aiWon ? 'Tehisintellektid mõistsid üksteist. Sinu eest jäi sõna peitu.'
        : 'Seekord ei leidnud õiget sõna ei sina ega kõik AI-mängijad.',
    });
    room.difficulty = next;
    room.phase = 'results';
    room.speaking = '';
  }

  fail(room) {
    room.controller?.abort();
    room.voiceController?.abort();
    return this.finish(room, true);
  }

  pause(room) {
    room.phase = 'paused';
    room.controller?.abort();
    room.voiceController?.abort();
    room.speaking = '';
  }

  expire(room) {
    // Stop paid generation when the browser has stopped checking in.
    if (['preparing', 'discussion'].includes(room.phase) && this.now() - room.touched > this.idleTimeout) this.pause(room);
  }
}
