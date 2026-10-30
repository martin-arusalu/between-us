// Test-only preload: all upstream API calls are intercepted, never sent to a real provider.
let guesses = 0;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://api.openai.com/v1/decisions') {
    const body = JSON.parse(options.body);
    const { target, guesses } = body.input[0].content[0].data;
    return Response.json({ answers: body.questions.map((question, index) => ({
      type: 'choice', name: question.name,
      choice: (target === 'umbrella' && guesses[index] === 'brolly') || (target === 'õhuniisutaja' && guesses[index] === 'õhuniisuti')
        ? 'equivalent' : 'different',
    })) });
  }
  if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected external request in test fixture.');
  const body = JSON.parse(options.body);
  const schema = body.text?.format?.name;
  let text;
  if (schema === 'secret_word_candidates') {
    const estonian = body.instructions.includes('Language: Estonian');
    text = JSON.stringify({ words: Array(12).fill(estonian ? 'kohmetus' : 'umbrella') });
  } else if (schema === 'solo_turn') {
    const final = body.instructions.includes('Vestlus on nüüd lõppenud');
    const firstClue = JSON.parse(body.input).transcript.length === 0;
    text = JSON.stringify(final
      ? { message: '', guess: ++guesses === 1 ? 'üllatus' : 'kohmetus' }
      : { message: firstClue ? 'Näidisvestlus: seda tunnet on raske peita.' : 'Kas see juhtub pigem võõraste inimeste seltskonnas?', guess: '' });
  } else text = 'pillow';
  return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] });
};
