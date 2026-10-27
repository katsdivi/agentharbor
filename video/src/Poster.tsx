import React from 'react';
import { AbsoluteFill } from 'remotion';
import { c, fonts } from './theme';
import { Body, BrowserFrame, Footage, Mark, Sticker } from './components';

/** README poster: links to the film. Uses the held worker-2 frame (real footage, redacted master). */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: c.ink }}>
    <AbsoluteFill style={{ background: 'radial-gradient(1200px 420px at 72% 118%, rgba(34,201,160,0.18), transparent 70%)' }} />
    <div style={{ position: 'absolute', left: 120, top: 150, width: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <Mark size={64} dark />
        <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 44, letterSpacing: '-0.03em', color: c.white }}>AgentHarbor</div>
      </div>
      <div style={{ height: 64 }} />
      <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 104, lineHeight: 1.02, letterSpacing: '-0.035em', color: c.white }}>Give agents a place to work.</div>
      <div style={{ height: 34 }} />
      <Body color={c.mutedOnInk} size={30}>Browser sessions. Accounts. Persistent state.</Body>
      <div style={{ height: 64 }} />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 18, background: c.teal, color: c.ink, borderRadius: 999, padding: '16px 30px 16px 18px', fontFamily: fonts.body, fontWeight: 700, fontSize: 26 }}>
        <svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill={c.ink} /><path d="M16 12 L29 20 L16 28 Z" fill={c.teal} /></svg>
        Watch the 56-second demo
      </div>
    </div>
    <div style={{ position: 'absolute', right: 100, top: 210 }}>
      <div style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 20, letterSpacing: '0.1em', textTransform: 'uppercase', color: c.white, marginBottom: 16 }}>Worker 2 · restored session</div>
      <BrowserFrame url="automationexercise.com" width={940} height={529} dark>
        <Footage src="footage/w2_restored.png" kind="still" width={940} height={529} from={{ x: 0, y: 0, w: 1920 }} />
      </BrowserFrame>
      <div style={{ position: 'absolute', right: -24, bottom: -40 }}><Sticker text="RESTORED" at={-100} size={60} /></div>
    </div>
    <div style={{ position: 'absolute', left: 120, bottom: 48, fontFamily: fonts.body, fontWeight: 500, fontSize: 18, color: 'rgba(255,255,255,0.55)' }}>Demo: local mode · AutomationExercise · edited demo of a real recorded run</div>
  </AbsoluteFill>
);
