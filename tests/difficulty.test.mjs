import { test } from 'node:test';
import assert from 'node:assert/strict';
import { difficultyLevel, nextDifficulty } from '../difficulty.mjs';
import { Game } from '../game.mjs';
import { createWordGenerator } from '../word-generator.mjs';

test('adaptive rules prioritize a correct human answer, then AI correctness, then simplify', () => {
  assert.equal(nextDifficulty(5, { humanCorrect: true, aiCorrect: true }), 6);
  assert.equal(nextDifficulty(5, { humanCorrect: true, aiCorrect: false }), 6);
  assert.equal(nextDifficulty(5, { humanCorrect: false, aiCorrect: true }), 5);
  assert.equal(nextDifficulty(5, { humanCorrect: false, aiCorrect: false }), 4);
  assert.equal(nextDifficulty(5, { humanCorrect: true, aiCorrect: true, scored: false }), 5);
  assert.equal(nextDifficulty(5, { humanCorrect: false, aiCorrect: false, scored: false }), 5);
});

test('difficulty stays within 1–10 and rejects invalid starting levels', () => {
  assert.equal(nextDifficulty(10, { humanCorrect: true }), 10);
  assert.equal(nextDifficulty(1, { humanCorrect: false, aiCorrect: false }), 1);
  assert.equal(difficultyLevel(), 5);
  assert.equal(difficultyLevel('medium'), 5);
  assert.equal(difficultyLevel('7'), 7);
  for (const value of [0, 11, 3.5, 'nope', null, true]) {
    assert.equal(difficultyLevel(value), null);
    assert.throws(() => new Game().create('You', { difficulty: value }), /integer from 1 to 10/);
  }
});

async function until(condition) {
  for (let i = 0; i < 250; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Test condition not reached.');
}

for (const scenario of [
  { name: 'everyone correct', human: true, ai: [true, true], next: 6 },
  { name: 'only human correct', human: true, ai: [false, false], next: 6 },
  { name: 'only AIs correct', human: false, ai: [true, true], next: 5 },
  { name: 'one AI correct', human: false, ai: [true, false], next: 5 },
  { name: 'nobody correct', human: false, ai: [false, false], next: 4 },
  { name: 'request failed', human: true, ai: [true, true], failed: true, next: 5 },
]) {
  test(`solo adapts and generates the next word at the new level: ${scenario.name}`, async t => {
    const levels = [];
    let currentWord;
    let finalIndex = 0;
    const game = new Game({ soloPace: 60_000,
      wordGenerator: async ({ difficulty }) => {
        levels.push(difficulty);
        currentWord = levels.length === 1 ? 'kohmetus' : 'kõhklus';
        return currentWord;
      },
      soloPlayer: async turn => {
        if (!turn.final) return { message: 'Üks tavaline vihje.', guess: '' };
        if (scenario.failed) throw new Error('Mock provider failure.');
        return { message: '', guess: scenario.ai[finalIndex++] ? currentWord : 'muu' };
      },
    });
    const s = game.create('You', { mode: 'solo', aiCount: 3 });
    const room = game.rooms.get(s.room.code);
    t.after(() => game.solo.pause(room));
    const action = (action, extra = {}) => game.action({ action, code: room.code, ...extra }, s.token);
    action('start');
    await until(() => room.messages.length === 1);
    action('answer', { word: scenario.human ? currentWord : 'inimese-vale-vastus' });
    await room.pending;
    const completed = game.view(room.code, s.token).history.at(-1);
    assert.equal(completed.difficulty, 5);
    assert.equal(completed.nextDifficulty, scenario.next);
    assert.equal(room.difficulty, scenario.next);
    // Accidental repeated finalization must not apply another adjustment.
    game.solo.finish(room);
    assert.equal(room.difficulty, scenario.next);
    assert.equal(room.history.length, 1);
    action('start');
    await until(() => levels.length === 2);
    assert.deepEqual(levels, [5, scenario.next]);
  });
}

test('numeric generation level is sent in the independent word-selection instructions', async () => {
  const generate = createWordGenerator({ apiKey: 'mock', request: async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.instructions.includes('Difficulty: 6/10'), true);
    assert.equal(JSON.parse(body.input).transcript, undefined);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ words: Array(12).fill('kõhklus') }) }] }] });
  } });
  assert.equal(await generate({ language: 'et', difficulty: 6 }), 'kõhklus');
});
