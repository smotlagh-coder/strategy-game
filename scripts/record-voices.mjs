/**
 * Records every leader's summit speech with the OpenAI speech model.
 *
 *   node scripts/record-voices.mjs                 # all leaders
 *   node scripts/record-voices.mjs canada brazil   # just these
 *
 * Needs OPENAI_API_KEY in the environment or in .env.local.
 * The lines themselves come from src/data/speeches.ts, so edit there, not here.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gpt-4o-mini-tts';

/** Timbre plus the direction that gives each leader their accent and attitude. */
const DELIVERY = {
  us: {
    voice: 'coral',
    instructions:
      'An American president addressing a summit. General American accent, polished and camera-ready, warm on the surface with steel underneath. Measured pace, clear consonants, a confident downward beat at the end of each sentence.',
  },
  uk: {
    voice: 'fable',
    instructions:
      'A British prime minister at a podium. Crisp received pronunciation, dry and understated, faintly weary. Precise diction, slight ironic lift on the qualifiers.',
  },
  france: {
    voice: 'ballad',
    instructions:
      'A French president speaking English with a distinct French accent. Silky, elegant, slightly condescending. Soft R sounds, melodic phrasing, unhurried pauses as though every word is a concession.',
  },
  russia: {
    voice: 'onyx',
    instructions:
      'A Russian marshal speaking English with a heavy Russian accent. Deep, gravelly, slow and utterly calm. Hard consonants, flat vowels, menace held just beneath a polite surface.',
  },
  china: {
    voice: 'echo',
    instructions:
      'A Chinese premier speaking English with a measured Mandarin accent. Composed, formal, unhurried. Even tone throughout, no theatrics, quiet certainty.',
  },
  india: {
    voice: 'verse',
    instructions:
      'An Indian prime minister speaking English with a clear Indian accent. Warm, rhythmic, statesmanlike. Rolling cadence, emphatic stress on the moral points.',
  },
  pakistan: {
    voice: 'ash',
    instructions:
      'A Pakistani general speaking English with a South Asian accent. Clipped, formal, military. Short controlled phrases, hard edge on the warning at the end.',
  },
  iran: {
    voice: 'alloy',
    instructions:
      'An Iranian president speaking English with a Persian accent. Calm, patient, faintly weary of being lectured. Smooth delivery, deliberate pauses, quiet defiance.',
  },
  northkorea: {
    voice: 'onyx',
    instructions:
      'A North Korean state broadcast. Strident, triumphant, over-declamatory, like a propaganda announcer. Rising intensity, hard emphatic stresses, chin-up bravado.',
  },
  canada: {
    voice: 'echo',
    instructions:
      'A Canadian prime minister speaking with a friendly Canadian accent. Affable, reasonable, disarmingly polite, with a firm practical edge under the warmth. Relaxed pace, gentle upward inflections.',
  },
  brazil: {
    voice: 'sage',
    instructions:
      'A Brazilian president speaking English with a Brazilian Portuguese accent. Warm, musical, expansive, proud. Open vowels, lilting rhythm, genuine passion on the lines about forests and people.',
  },
  australia: {
    voice: 'ash',
    instructions:
      'An Australian prime minister speaking with a broad Australian accent. Laconic, cheerful, blunt. Flat drawled vowels, rising terminals, a cheeky grin behind the threat at the end.',
  },
};

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envFile = join(root, '.env.local');
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/^\s*OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  throw new Error('OPENAI_API_KEY not found in the environment or .env.local');
}

/** Pulls nationId / audioSrc / publicLine straight out of the speech table. */
function readSpeeches() {
  const src = readFileSync(join(root, 'src/data/speeches.ts'), 'utf8');
  const entries = [...src.matchAll(/nationId: '([^']+)',[\s\S]*?audioSrc: '([^']+)',[\s\S]*?publicLine:\s*([\s\S]*?),\n\s*trueIntent:/g)];
  return entries.map(([, nationId, audioSrc, rawLine]) => ({
    nationId,
    audioSrc,
    line: [...rawLine.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map((m) => m[1].replace(/\\'/g, "'"))
      .join('')
      .trim(),
  }));
}

async function record(key, speech) {
  const delivery = DELIVERY[speech.nationId];
  if (!delivery) throw new Error(`No delivery direction for ${speech.nationId}`);

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      voice: delivery.voice,
      input: speech.line,
      instructions: delivery.instructions,
      response_format: 'wav',
    }),
  });
  if (!res.ok) throw new Error(`${speech.nationId}: ${res.status} ${await res.text()}`);

  const out = join(root, 'public', speech.audioSrc.replace(/^\//, ''));
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

const only = process.argv.slice(2);
const key = loadKey();
const speeches = readSpeeches().filter((s) => only.length === 0 || only.includes(s.nationId));
if (speeches.length === 0) throw new Error(`No speeches matched: ${only.join(', ')}`);

for (const speech of speeches) {
  const out = await record(key, speech);
  console.log(`${speech.nationId.padEnd(11)} ${DELIVERY[speech.nationId].voice.padEnd(7)} → ${out}`);
}
