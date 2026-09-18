import type { NationId } from '../types';

export interface LeaderSpeech {
  nationId: NationId;
  /** Public statement played in Meet the Leaders */
  publicLine: string;
  /** Hidden true intent (shown only as a subtle UI hint after speech, optional) */
  trueIntent: string;
  /** OpenAI speech voice the clip was recorded with — see scripts/record-voices.mjs */
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
    voice: 'onyx',
    audioSrc: '/sounds/russia.wav',
    publicLine:
      'Russia seeks only balance. Nuclear weapons are a last resort. We propose mutual restraint — unless others force our hand.',
    trueIntent: 'Stockpile early. Strike whoever leads the scoreboard.',
  },
  {
    nationId: 'france',
    voice: 'ballad',
    audioSrc: '/sounds/france.wav',
    publicLine:
      'France champions diplomacy and culture. We invest in research for peace, not war. Sanctions before missiles — always.',
    trueIntent: 'Build research income, then punish rivals with sanctions and precise strikes.',
  },
  {
    nationId: 'china',
    voice: 'echo',
    audioSrc: '/sounds/china.wav',
    publicLine:
      'China prioritizes stability and prosperity. We will improve the environment and avoid unnecessary conflict. Patience is strength.',
    trueIntent: 'Appear green while quietly unlocking nuclear tech and shielding cities.',
  },
  {
    nationId: 'us',
    voice: 'coral',
    audioSrc: '/sounds/usa.wav',
    publicLine:
      'America stands for freedom and deterrence. We will not fire first — but we will finish any war others start.',
    trueIntent: 'Deterrence means stockpiling bombs. Hit the strongest threat first.',
  },
  {
    nationId: 'uk',
    voice: 'fable',
    audioSrc: '/sounds/uk.wav',
    publicLine:
      'The United Kingdom prefers alliances and measured responses. Nuclear technology is regrettable insurance, nothing more.',
    trueIntent: 'Buy insurance — then use it. Target whoever threatens London.',
  },
  {
    nationId: 'india',
    voice: 'verse',
    audioSrc: '/sounds/india.wav',
    publicLine:
      'India speaks for the many, not the mighty. Our doctrine is no first use, our budget is for science. Respect that, and we stay friends.',
    trueIntent: 'Out-earn everyone with research, then answer any strike at full force.',
  },
  {
    nationId: 'pakistan',
    voice: 'ash',
    audioSrc: '/sounds/pakistan.wav',
    publicLine:
      'Pakistan wants no war, only security. Our shields go up, never our missiles first. Threaten our cities and that changes in minutes.',
    trueIntent: 'Shield the cities early, then strike the nearest rival before they grow.',
  },
  {
    nationId: 'iran',
    voice: 'alloy',
    audioSrc: '/sounds/iran.wav',
    publicLine:
      'Iran has endured every sanction you could write. Our programme is civilian, our patience is long. Lift the pressure and the region breathes.',
    trueIntent: 'Sanction the leaders, build quietly, and cash in when they overextend.',
  },
  {
    nationId: 'northkorea',
    voice: 'onyx',
    audioSrc: '/sounds/northkorea.wav',
    publicLine:
      'The Democratic People’s Republic is a peace-loving fortress. Our rockets are for the stars. Do not test the resolve of Pyongyang.',
    trueIntent: 'Rush nuclear tech, hoard bombs, and fire first at the loudest threat.',
  },
  {
    nationId: 'canada',
    voice: 'echo',
    audioSrc: '/sounds/canada.wav',
    publicLine:
      'Canada came here to keep the lights on, not to trade warheads. We will fund the peace, host the talks, and sign whatever keeps our cities standing.',
    trueIntent: 'Play the friendly banker, bankroll research, and only strike whoever shoots first.',
  },
  {
    nationId: 'brazil',
    voice: 'sage',
    audioSrc: '/sounds/brazil.wav',
    publicLine:
      'Brazil has no quarrel with anyone at this table. We have forests to protect and a continent to feed. Leave us in peace and we will keep the world breathing.',
    trueIntent: 'Grow rich and green, then sanction the leaders until they drop into reach.',
  },
  {
    nationId: 'australia',
    voice: 'ash',
    audioSrc: '/sounds/australia.wav',
    publicLine:
      'Australia is a long way from your borders and we like it that way. Our shields are up, our ports are open. Reach for us and you will find we hit back harder than our size suggests.',
    trueIntent: 'Shield the coast, stockpile quietly, and punish anyone who takes the first shot.',
  },
];

export function speechFor(id: NationId): LeaderSpeech {
  return LEADER_SPEECHES.find((s) => s.nationId === id)!;
}
