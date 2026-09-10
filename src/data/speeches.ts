import type { NationId } from '../types';

export interface LeaderSpeech {
  nationId: NationId;
  /** Public statement played in Meet the Leaders */
  publicLine: string;
  /** Hidden true intent (shown only as a subtle UI hint after speech, optional) */
  trueIntent: string;
  /** macOS `say` voice name used to generate the clip */
  voice: string;
  audioSrc: string;
}

/**
 * Diplomatic theater: every leader claims peaceful intent.
 * Their trueIntent is what the AI / strategy actually leans toward.
 */
export const LEADER_SPEECHES: LeaderSpeech[] = [
  {
    nationId: 'russia',
    voice: 'Ralph',
    audioSrc: '/sounds/russia.wav',
    publicLine:
      'Russia seeks only balance. Nuclear weapons are a last resort. We propose mutual restraint — unless others force our hand.',
    trueIntent: 'Stockpile early. Strike whoever leads the scoreboard.',
  },
  {
    nationId: 'france',
    voice: 'Thomas',
    audioSrc: '/sounds/france.wav',
    publicLine:
      'France champions diplomacy and culture. We invest in research for peace, not war. Sanctions before missiles — always.',
    trueIntent: 'Build research income, then punish rivals with sanctions and precise strikes.',
  },
  {
    nationId: 'china',
    voice: 'Reed (English (US))',
    audioSrc: '/sounds/china.wav',
    publicLine:
      'China prioritizes stability and prosperity. We will improve the environment and avoid unnecessary conflict. Patience is strength.',
    trueIntent: 'Appear green while quietly unlocking nuclear tech and shielding cities.',
  },
  {
    nationId: 'us',
    voice: 'Samantha',
    audioSrc: '/sounds/usa.wav',
    publicLine:
      'America stands for freedom and deterrence. We will not fire first — but we will finish any war others start.',
    trueIntent: 'Deterrence means stockpiling bombs. Hit the strongest threat first.',
  },
  {
    nationId: 'uk',
    voice: 'Daniel',
    audioSrc: '/sounds/uk.wav',
    publicLine:
      'The United Kingdom prefers alliances and measured responses. Nuclear technology is regrettable insurance, nothing more.',
    trueIntent: 'Buy insurance — then use it. Target whoever threatens London.',
  },
];

export function speechFor(id: NationId): LeaderSpeech {
  return LEADER_SPEECHES.find((s) => s.nationId === id)!;
}
