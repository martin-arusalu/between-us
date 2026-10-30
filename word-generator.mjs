import { randomInt, randomUUID } from 'node:crypto';
import { difficultyLevel } from './difficulty.mjs';

const BATCH_SIZE = 12;
const RECENT_LIMIT = 500;
const normalize = word => typeof word === 'string' ? word.normalize('NFKC').trim().toLowerCase() : '';

// This request is independent of every player request: no conversation ID or shared history.
export function createWordGenerator({ apiKey, model = 'gpt-4.1-mini', request = fetch, pick = randomInt } = {}) {
  if (!apiKey) return null;
  // Shared by all rooms using this generator. Only words actually picked enter this bounded history.
  const recent = new Set();
  return async ({ language = 'et', difficulty = 5, exclude = [] }, signal) => {
    const level = difficultyLevel(difficulty);
    if (level === null) throw new Error('Difficulty must be an integer from 1 to 10.');
    const instructions = `Generate ${BATCH_SIZE} distinct candidate secret words for a word-guessing game. The server will choose one randomly; you must not favor or designate a winner. Return only the requested JSON object with a words array.
Language: ${language === 'et' ? 'Estonian' : 'English'}. Use one real, established noun in its singular dictionary form (Estonian: nimetav kääne). No proper names, invented words, phrases, spaces or abbreviations.
Difficulty: ${level}/10. Treat 1 as easiest and 10 as hardest; calibrate within the band rather than treating the scale as a few fixed categories.
${level <= 2
  ? 'Use very common, immediately recognizable vocabulary, straightforward to identify from one clear clue. Avoid ambiguity or unusual words.'
  : level <= 4
    ? 'Use familiar everyday vocabulary, a little more specific than a beginner word. It should need one or two distinguishing clues.'
    : level <= 6
      ? 'Use medium-difficulty vocabulary: familiar to an ordinary adult, but more specific than beginner words. Each word should take a few distinguishing clues to identify. Avoid obscure vocabulary or specialist knowledge.'
      : level <= 8
        ? 'Use challenging but established vocabulary requiring several precise clues, while still understandable in ordinary conversation.'
        : 'Use difficult but human-familiar vocabulary with subtle distinctions or overlapping associations, rewarding several careful clues. Do not use obscure trivia or specialist jargon merely to increase difficulty.'}
Prioritize human familiarity over rarity. No topic, category, theme or initial letter is prescribed. Draw from the unrestricted vocabulary of the requested language. Candidates must be meaningfully different, not a themed list, synonyms or close word-family variants. Do not return any excluded word or a trivial variant of one. The nonce is only for variety, not a clue or code. You have no role in the subsequent game; do not provide clues or explanations.`;
    // Retry once if the model ignores exclusions or returns no usable candidates.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const excluded = new Set([...exclude.map(normalize), ...recent]);
      const response = await request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model, store: false, instructions,
          input: JSON.stringify({ exclude: [...excluded], nonce: randomUUID() }),
          max_output_tokens: 1800,
          text: { format: { type: 'json_schema', name: 'secret_word_candidates', strict: true,
            schema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' }, minItems: BATCH_SIZE, maxItems: BATCH_SIZE } },
              required: ['words'], additionalProperties: false } } },
        }),
      });
      if (!response.ok) throw new Error(`Word generation failed (HTTP ${response.status}).`);
      const data = await response.json();
      if (data.status === 'incomplete') throw new Error('Incomplete word response.');
      const text = (data.output || []).flatMap(o => o.content || [])
        .filter(c => c.type === 'output_text').map(c => c.text || '').join('');
      const { words } = JSON.parse(text);
      if (!Array.isArray(words) || words.length !== BATCH_SIZE) continue;
      // Recheck recent picks after awaiting the API: another room may have picked in the meantime.
      const candidates = [...new Set(words.map(normalize))].filter(word =>
        /^[\p{L}][\p{L}\p{M}-]{2,39}$/u.test(word) && !excluded.has(word) && !recent.has(word));
      if (!candidates.length) continue;
      signal?.throwIfAborted();
      const word = candidates[pick(candidates.length)];
      recent.add(word);
      if (recent.size > RECENT_LIMIT) recent.delete(recent.values().next().value);
      return word;
    }
    throw new Error('The generator did not return a new single word.');
  };
}
