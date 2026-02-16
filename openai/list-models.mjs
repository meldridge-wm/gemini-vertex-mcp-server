import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const models = await client.models.list();
const relevant = [];
for await (const m of models) {
  const id = m.id;
  const skip = ['audio', 'transcri', 'tts', 'whisper', 'realtime', 'dall', 'embed', 'moderation', 'babbage', 'davinci', 'search'];
  if (/^(gpt-|o[0-9]|codex)/.test(id) && !skip.some(s => id.includes(s))) {
    relevant.push(id);
  }
}
relevant.sort();
console.log(relevant.join('\n'));
