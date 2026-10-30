import { createObserver } from '../../../observer.mjs';
import { createAIPlayer } from '../../../ai-player.mjs';
import { createSpeech } from '../../../speech.mjs';
import { createWordGenerator } from '../../../word-generator.mjs';
import { createAnswerJudge } from '../../../answer-judge.mjs';

export function createProviders(env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  return {
    observer: createObserver({ apiKey, model }),
    aiMode: apiKey ? 'openai' : 'practice',
    soloPlayer: createAIPlayer({ apiKey, model, guesserModel: env.OPENAI_GUESSER_MODEL || 'gpt-5.4-nano' }),
    wordGenerator: createWordGenerator({ apiKey, model }),
    answerJudge: createAnswerJudge({ apiKey }),
    speech: createSpeech({ apiKey: env.ELEVENLABS_API_KEY?.trim(), model: env.ELEVENLABS_MODEL || 'eleven_v3',
      voiceIds: (env.ELEVENLABS_VOICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean) }),
  };
}
