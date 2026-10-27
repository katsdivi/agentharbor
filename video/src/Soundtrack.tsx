import React from 'react';
import { Html5Audio, interpolate, Sequence, staticFile } from 'remotion';
import { T } from './Film';
import { FPS } from './theme';

/*
 * Soundtrack (all ElevenLabs generations, see README.md · Audio).
 * Voice-over lines sit inside the act they describe; the music bed ducks under them.
 * Frames are absolute film frames at 30 fps.
 */
const s = (sec: number) => Math.round(sec * FPS);

type Line = { src: string; at: number; trimBefore?: number; len: number };
// len = clip length in frames (after trimBefore), used for ducking.
const VO: Line[] = [
  { src: 'vo-1-open', at: 54, len: s(2.32) }, // "Give agents a place to work." (headline lands at 56)
  { src: 'vo-2-signup', at: T.signup + 18, len: s(11.12) }, // account_register … "No human typing or clicking."
  { src: 'vo-3-login', at: T.session + 12, len: s(4.24) }, // logs out and back in with stored credentials
  { src: 'vo-4-save', at: T.session + 219, len: s(5.84) }, // saves encrypted state; first worker shuts down
  { src: 'vo-5-restore', at: T.hero + 30, len: s(9.92) }, // fresh worker restores the login
  { src: 'vo-6-cleanup', at: T.cleanup - 6, len: s(7.28) }, // deletes, verifies login fails, removes record and inbox
  // End line, with its long pause after "AgentHarbor" shortened (0.84 s kept, resumes at 1.9 s).
  { src: 'vo-7-end', at: T.end + 39, len: s(0.84) },
  { src: 'vo-7-end', at: T.end + 72, trimBefore: s(1.9), len: s(2.98) },
];

type Fx = { src: string; at: number; volume: number };
const whoosh = (at: number): Fx => ({ src: 'sfx-whoosh', at: at - 8, volume: 0.5 });
const tick = (at: number): Fx => ({ src: 'sfx-tick', at, volume: 0.3 });
const chime = (at: number): Fx => ({ src: 'sfx-chime', at: at - 7, volume: 0.35 }); // hit lands 0.22 s in
const FX: Fx[] = [
  // act transitions
  whoosh(T.signup - 6), whoosh(T.session), whoosh(T.hero), whoosh(T.cleanup),
  // tool chips and checks as they appear
  tick(T.signup - 6 + 80), tick(T.signup - 6 + 235), // account_register, job_status
  tick(T.session + 34), tick(T.session + 280), tick(T.session + 350), // browser_fill, session_save_state, session_close
  tick(T.hero + 181), // session_start
  tick(T.cleanup + 34), tick(T.cleanup + 86), tick(T.cleanup + 122), tick(T.cleanup + 140),
  // success moments: Account Created, SIGNED IN, restored session held
  chime(T.signup - 6 + 215), chime(T.session + 146), chime(T.hero + 115),
  { src: 'sfx-resolve', at: T.end, volume: 0.6 },
];

const MUSIC = 0.42, DUCKED = 0.16, RAMP = 8;
const musicVolume = (f: number) => {
  let v = MUSIC;
  for (const l of VO) {
    const d = interpolate(f, [l.at - RAMP, l.at, l.at + l.len, l.at + l.len + RAMP], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    v = Math.min(v, MUSIC - (MUSIC - DUCKED) * d);
  }
  return v;
};

export const Soundtrack: React.FC = () => (
  <>
    <Html5Audio src={staticFile('audio/music.mp3')} volume={musicVolume} />
    {VO.map((l, i) => (
      <Sequence key={`vo${i}`} from={l.at} durationInFrames={l.len} layout="none">
        <Html5Audio src={staticFile(`audio/${l.src}.mp3`)} trimBefore={l.trimBefore} volume={1} />
      </Sequence>
    ))}
    {FX.map((x, i) => (
      <Sequence key={`fx${i}`} from={x.at} layout="none">
        <Html5Audio src={staticFile(`audio/${x.src}.mp3`)} volume={x.volume} />
      </Sequence>
    ))}
  </>
);
