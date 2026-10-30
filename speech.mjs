export function createSpeech({ apiKey, model = 'eleven_v3', voiceIds = [], request = fetch } = {}) {
  if (!apiKey) return null;
  voiceIds = [...new Set(voiceIds)];
  let voicesPromise;
  async function voices(signal, required) {
    if (voiceIds.length >= required) return voiceIds;
    if (!voicesPromise) voicesPromise = (async () => {
      const response = await request('https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=30', {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Could not load voices.');
      const data = await response.json();
      const ids = [...new Set([...voiceIds, ...(data.voices || []).map(v => v.voice_id)])].filter(Boolean);
      if (ids.length < 3) throw new Error('Three distinct voices are required.');
      return ids;
    })().catch(error => { voicesPromise = null; throw error; });
    if (signal?.aborted) throw new Error('Speech cancelled.');
    return voicesPromise;
  }
  return async (text, voiceIndex, signal) => {
    const ids = await voices(signal, voiceIndex + 1);
    if (signal?.aborted) throw new Error('Speech cancelled.');
    const response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ids[voiceIndex % ids.length])}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
      body: JSON.stringify({ text, model_id: model, language_code: 'et' }),
    });
    if (!response.ok) {
      console.error(`ElevenLabs speech request failed (HTTP ${response.status}).`);
      throw new Error('Speech generation failed.');
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 8_000_000) throw new Error('Invalid audio.');
    return audio;
  };
}
