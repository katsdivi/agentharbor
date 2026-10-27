import React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from 'remotion';
import { c, ease, fonts, W, H } from './theme';
import { Body, BrowserFrame, ContextBar, FocusIn, Footage, Headline, HiddenNote, Mark, mix, Rect, Step, Sticker, Sweep, ToolChip, useIn, useMove, whip } from './components';

/*
 * Timeline (30 fps). Source times are seconds in the redacted masters:
 * w1 = worker 1 from raw 1.6 s on; w2 = worker 2 in full. See docs/demo/README.md.
 */
export const T = {
  open: 0,
  signup: 165,
  session: 540,
  hero: 930,
  cleanup: 1320,
  end: 1500,
  total: 1680,
};
const TAIL = 24; // outgoing scene keeps rendering under the next scene's transition

const FULL: Rect = { x: 0, y: 0, w: 1920 };
// Crop rects in source pixels (1920x1080 footage).
const R = {
  form: { x: 380, y: 0, w: 960 },
  fields: { x: 452, y: 250, w: 560 },
  button: { x: 400, y: 450, w: 440 },
  created: { x: 380, y: 110, w: 1080 },
  createdHead: { x: 455, y: 165, w: 900 },
  nav: { x: 1045, y: 6, w: 420 },
  heroNav: { x: 1045, y: 8, w: 560 },
  login: { x: 440, y: 200, w: 1000 },
  deletedHead: { x: 455, y: 165, w: 900 },
};

/** Horizontal motion blur via SVG (CSS blur is isotropic). */
const WhipBlur: React.FC<{ id: string; amount: number; children: React.ReactNode }> = ({ id, amount, children }) => (
  <AbsoluteFill style={{ filter: amount > 0.5 ? `url(#${id})` : undefined }}>
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <filter id={id} x="-20%" y="0" width="140%" height="100%">
        <feGaussianBlur stdDeviation={`${amount} 0`} />
      </filter>
    </svg>
    {children}
  </AbsoluteFill>
);

const Ground: React.FC<{ dark?: boolean; children: React.ReactNode }> = ({ dark, children }) => (
  <AbsoluteFill style={{ background: dark ? c.ink : c.paper }}>
    {/* one restrained light source, low in frame, as in the primary reference */}
    <AbsoluteFill style={{ background: dark ? 'radial-gradient(1200px 420px at 70% 118%, rgba(34,201,160,0.16), transparent 70%)' : 'radial-gradient(1100px 460px at 80% 120%, rgba(34,201,160,0.14), transparent 70%)' }} />
    {children}
  </AbsoluteFill>
);

/* ───────────────────────── 1 · Opening ───────────────────────── */
const Opening: React.FC = () => {
  const f = useCurrentFrame();
  // Mark: focus in at centre, then expands into the name pill and rises.
  const markIn = useIn(4, 22);
  const pill = useMove(30, 22);
  const rise = useMove(52, 24);
  const glimpse = useIn(70, 28);
  const out = whip(f, T.signup - T.open - 6, 12);
  return (
    <WhipBlur id="w-open" amount={out.blur}>
      <AbsoluteFill style={{ transform: `translateX(${-out.p * W * 0.6}px)`, opacity: 1 - out.p * 0.6 }}>
        <Ground>
          <div style={{ position: 'absolute', left: '50%', top: mix(470, 150, rise), transform: `translate(-50%, -50%) scale(${mix(1.25, 1, rise)})`, opacity: markIn, filter: `blur(${(1 - markIn) * 16}px)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, background: c.white, borderRadius: 999, padding: `12px ${mix(12, 30, pill)}px 12px 12px`, boxShadow: `0 20px 60px rgba(11,15,20,${0.12 * pill})` }}>
              <Mark size={76} />
              <div style={{ overflow: 'hidden', width: mix(0, 280, pill), whiteSpace: 'nowrap', fontFamily: fonts.display, fontWeight: 700, fontSize: 46, letterSpacing: '-0.03em', color: c.ink }}>AgentHarbor</div>
            </div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 236, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
            <Headline text="Give agents a place to work." at={56} size={104} align="center" />
            <FocusIn at={78}>
              <Body size={32}>Browser sessions. Accounts. Persistent state.</Body>
            </FocusIn>
          </div>
          {/* immediate glimpse of the product: worker 1, logging back in (real footage) */}
          <div style={{ position: 'absolute', left: '50%', top: mix(1180, 560, glimpse), transform: 'translateX(-50%)' }}>
            <BrowserFrame url="automationexercise.com" width={1240} height={700}>
              <Sequence from={70} layout="none">
                <Footage src="footage/w1.mp4" kind="video" width={1240} height={698} from={FULL} trimBefore={Math.round(13.9 * 30)}>
                  {f < 87 && <div style={{ position: 'absolute', left: 500, top: 312 }}><HiddenNote /></div>}
                </Footage>
              </Sequence>
            </BrowserFrame>
          </div>
        </Ground>
      </AbsoluteFill>
    </WhipBlur>
  );
};

/* ───────────────────────── 2 · Signup (dark) ───────────────────────── */
const Signup: React.FC = () => {
  const f = useCurrentFrame();
  const enter = whip(f, 0, 12);
  // Shots (local frames): A form overview → B field close-up → C button → D created (video) → E created close-up
  const A = 0, B = 70, C = 165, D = 215, E = 285;
  const toFields = useMove(B, 26);
  const toButton = useMove(C, 18);
  const pullBack = useMove(D, 1);
  const toHead = useMove(E, 26);
  const ringIn = useIn(C + 14, 10);
  const shot = f < D ? 'still' : 'video';
  let from: Rect = R.form, to: Rect = R.fields, t = toFields;
  if (f >= C) { from = R.fields; to = R.button; t = toButton; }
  if (f >= D) { from = R.created; to = R.createdHead; t = toHead; }
  const frameW = 1100, frameH = 619;
  return (
    <WhipBlur id="w-signup" amount={(1 - enter.p) * 50}>
      <AbsoluteFill style={{ transform: `translateX(${(1 - enter.p) * W * 0.5}px)`, boxShadow: `-${W}px 0 0 0 ${c.ink}` }}>
        <Ground dark>
          <div style={{ position: 'absolute', left: 120, top: 150, width: 520 }}>
            <FocusIn at={10}><Step n="01" label="Signup" dark /></FocusIn>
            <div style={{ height: 36 }} />
            <Headline text="From signup to signed in." at={16} size={88} color={c.white} />
            <div style={{ height: 40 }} />
            <FocusIn at={B + 10}><ToolChip tool="account_register" detail='mode: "local"' dark /></FocusIn>
            <div style={{ height: 16 }} />
            <FocusIn at={B + 18}><Body color={c.mutedOnInk} size={24}>Synthetic profile. The site sends no verification email.</Body></FocusIn>
            <div style={{ height: 30 }} />
            {f >= D + 20 && <FocusIn at={D + 20}><ToolChip tool="job_status" detail="completed · confirmed" dark /></FocusIn>}
          </div>
          <div style={{ position: 'absolute', right: 100, top: 200 }}>
            <BrowserFrame url={f < D ? 'automationexercise.com/signup' : 'automationexercise.com/account_created'} width={frameW} height={frameH} dark>
              {shot === 'still' ? (
                <Footage src="footage/w1_form.png" kind="still" width={frameW} height={frameH} from={from} to={to} t={t} />
              ) : (
                <Sequence from={D} layout="none">
                  <Footage src="footage/w1.mp4" kind="video" width={frameW} height={frameH} from={from} to={to} t={t} trimBefore={Math.round(0.85 * 30)} />
                </Sequence>
              )}
              {/* button focus ring during shot C */}
              {f >= C + 14 && f < D && (
                <div style={{ position: 'absolute', left: (486 - R.button.x) * (frameW / R.button.w) - 10, top: (568 - R.button.y) * (frameW / R.button.w) - 10, width: 150 * (frameW / R.button.w) + 20, height: 30 * (frameW / R.button.w) + 20, borderRadius: 14, border: `3px solid ${c.teal}`, opacity: ringIn, boxShadow: `0 0 0 10px ${c.tealGlow}` }} />
              )}
            </BrowserFrame>
          </div>
          {f >= E + 18 && (
            <div style={{ position: 'absolute', right: 150, top: 760 }}>
              <Sticker text="ACCOUNT CREATED" at={E + 18} />
            </div>
          )}
          {void pullBack}
          {void A}
        </Ground>
      </AbsoluteFill>
    </WhipBlur>
  );
};

/* ───────────────────────── 3 · Session lifecycle (light) ───────────────────────── */
const Node: React.FC<{ title: string; sub: string; at: number; x: number; dim?: number; accent?: boolean }> = ({ title, sub, at, x, dim = 0, accent }) => (
  <div style={{ position: 'absolute', left: x, top: 0, width: 300 }}>
    <FocusIn at={at}>
      <div style={{ background: c.white, borderRadius: 22, padding: '26px 28px', border: `1px solid ${accent ? c.teal : c.line}`, boxShadow: '0 18px 50px rgba(11,15,20,0.08)', opacity: 1 - dim * 0.55, filter: `grayscale(${dim})` }}>
        <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 34, letterSpacing: '-0.02em', color: c.ink }}>{title}</div>
        <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 20, color: c.muted, marginTop: 6 }}>{sub}</div>
      </div>
    </FocusIn>
  </div>
);

const Session: React.FC = () => {
  const f = useCurrentFrame();
  // Shots: A login footage (0.5x) → B nav close-up → C diagram with save/close events
  const B = 120, C = 190;
  const toNav = useMove(B, 24);
  const diagIn = useMove(C, 22);
  const line1 = useIn(C + 26, 20), line2 = useIn(C + 40, 20);
  const save = useMove(C + 90, 40);
  const close = useIn(C + 160, 16);
  const frameW = 1060, frameH = 596;
  const footLeft = 760;
  const footOut = useMove(C, 22);
  const loginZoom = useMove(56, 30);
  return (
    <Sweep at={0} dur={22}>
      <Ground>
        <div style={{ position: 'absolute', left: 120, top: 150, width: 440, opacity: 1 - footOut, filter: `blur(${footOut * 10}px)` }}>
          <FocusIn at={14}><Step n="02" label="Session" /></FocusIn>
          <div style={{ height: 36 }} />
          <Headline text="Log out. Log back in." at={20} size={84} />
          <div style={{ height: 40 }} />
          <FocusIn at={34}><ToolChip tool="browser_fill" detail='secret: "account_password"' /></FocusIn>
          <div style={{ height: 14 }} />
          <FocusIn at={44}><Body size={24}>Stored credentials, filled by reference.</Body></FocusIn>
        </div>
        <div style={{ position: 'absolute', left: footLeft, top: 190, opacity: 1 - footOut, transform: `translateY(${-footOut * 60}px) scale(${1 - footOut * 0.06})`, filter: `blur(${footOut * 12}px)` }}>
          <BrowserFrame url={f < 49 ? 'automationexercise.com/login' : 'automationexercise.com'} width={frameW} height={frameH} badge={f < B ? '0.5×' : undefined}>
            {f < B ? (
              <Footage src="footage/w1.mp4" kind="video" width={frameW} height={frameH} from={R.login} to={FULL} t={loginZoom} trimBefore={Math.round(13.62 * 30)} playbackRate={0.5}>
                {/* the email field was cleared in the master; this note says so */}
                {f >= 9 && f < 49 && <div style={{ position: 'absolute', left: 500, top: 312 }}><HiddenNote /></div>}
              </Footage>
            ) : (
              <Footage src="footage/w1_home.png" kind="still" width={frameW} height={frameH} from={FULL} to={R.nav} t={toNav} />
            )}
          </BrowserFrame>
          {f >= B + 26 && <div style={{ position: 'absolute', right: -30, top: 470 }}><Sticker text="SIGNED IN" at={B + 26} rotate={3} size={56} /></div>}
        </div>
        {/* Explanatory diagram, not captured telemetry */}
        {f >= C && (
          <AbsoluteFill style={{ opacity: diagIn }}>
            <div style={{ position: 'absolute', left: 120, top: 150 }}>
              <Step n="02" label="Session" />
              <div style={{ height: 30 }} />
              <Headline text="Save the session. Close the browser." at={C + 4} size={72} />
            </div>
            <div style={{ position: 'absolute', right: 120, top: 160, fontFamily: fonts.body, fontWeight: 600, fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: c.muted, border: `1px dashed ${c.line}`, padding: '6px 12px', borderRadius: 8 }}>Illustration</div>
            <div style={{ position: 'absolute', left: 230, top: 470, width: 1460, height: 220 }}>
              <svg width="1460" height="220" style={{ position: 'absolute', left: 0, top: 0 }}>
                <line x1="300" y1="62" x2={300 + 280 * line1} y2="62" stroke={c.ink} strokeWidth="2" />
                <line x1="880" y1="62" x2={880 + 280 * line2} y2="62" stroke={c.ink} strokeWidth="2" strokeDasharray={close > 0 ? '6 8' : undefined} opacity={1 - close * 0.6} />
              </svg>
              <Node title="Agent" sub="Claude, via MCP" at={C + 14} x={0} />
              <Node title="AgentHarbor" sub="encrypted account vault" at={C + 22} x={580} accent />
              <Node title="Browser" sub="worker 1 · local" at={C + 30} x={1160} dim={close} />
              {/* saved state travels from the browser back into the vault */}
              {f >= C + 90 && (
                <div style={{ position: 'absolute', left: mix(1150, 760, save), top: 150, transform: 'translateX(-50%)', opacity: interpolate(save, [0, 0.1, 1], [0, 1, 1]) }}>
                  <ToolChip tool="session_save_state" detail="2 cookies · encrypted" />
                </div>
              )}
              {f >= C + 160 && (
                <div style={{ position: 'absolute', left: 1310, top: -70, transform: 'translateX(-50%)', opacity: close }}>
                  <ToolChip tool="session_close" status="stopped" />
                </div>
              )}
            </div>
          </AbsoluteFill>
        )}
      </Ground>
    </Sweep>
  );
};

/* ───────────────────────── 4 · Hero: restoration (dark) ───────────────────────── */
const Hero: React.FC = () => {
  const f = useCurrentFrame();
  const head = useMove(64, 26); // centred headline → top
  const cards = useIn(78, 26);
  const play = 84; // worker 2 footage starts (0.5x), source 7.30 s; first paint at 7.36 s
  const hold = play + 31; // held last frame: source 7.82 s, before the delete click at 7.84 s
  const push = useMove(hold + 18, 60);
  const w1Away = useMove(hold + 6, 26);
  const frameW = 1000, frameH = 562;
  const drift = interpolate(f, [hold + 78, T.cleanup - T.hero], [1, 1.035], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Sweep at={0} dur={22}>
      <Ground dark>
        <div style={{ position: 'absolute', left: 0, right: 0, top: mix(390, 96, head), transform: `scale(${mix(1, 0.62, head)})`, transformOrigin: '50% 0' }}>
          <Headline text="A new browser." at={10} size={112} color={c.white} align="center" />
          <div style={{ height: 8 }} />
          <Headline text="The session continues." at={22} size={112} color={c.teal} align="center" />
        </div>
        {/* Worker 1: the closed process, shown as its last frame */}
        <div style={{ position: 'absolute', left: mix(120, -160, w1Away), top: 420, opacity: cards * (1 - w1Away), transform: `scale(${mix(0.96, 0.9, w1Away)})`, transformOrigin: '0 50%' }}>
          <div style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 20, letterSpacing: '0.1em', textTransform: 'uppercase', color: c.mutedOnInk, marginBottom: 16 }}>Worker 1 · closed</div>
          <BrowserFrame url="automationexercise.com" width={560} height={315} dark dim={1}>
            <Footage src="footage/w1_home.png" kind="still" width={560} height={315} from={FULL} />
          </BrowserFrame>
        </div>
        {/* Worker 2: a new local process started with the saved cookies */}
        <div style={{ position: 'absolute', left: mix(1100, 800, cards), top: 300, opacity: cards, transform: `scale(${drift})`, transformOrigin: '50% 55%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
            <div style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 20, letterSpacing: '0.1em', textTransform: 'uppercase', color: c.white }}>Worker 2 · new process</div>
            {f >= play && <span style={{ width: 10, height: 10, borderRadius: 5, background: c.teal, boxShadow: `0 0 0 6px ${c.tealGlow}` }} />}
          </div>
          <BrowserFrame url="automationexercise.com" width={frameW} height={frameH} dark badge={f >= play && f < hold ? '0.5×' : undefined}>
            {f < play ? (
              <div style={{ width: frameW, height: frameH, background: '#fff' }} />
            ) : f < hold ? (
              <Sequence from={play} layout="none">
                <Footage src="footage/w2.mp4" kind="video" width={frameW} height={frameH} from={FULL} trimBefore={Math.round(7.3 * 30)} playbackRate={0.5} />
              </Sequence>
            ) : (
              <Footage src="footage/w2_restored.png" kind="still" width={frameW} height={frameH} from={FULL} to={R.heroNav} t={push} />
            )}
          </BrowserFrame>
        </div>
        {/* separator between the two processes */}
        <div style={{ position: 'absolute', left: 740, top: 360, width: 2, height: 440, background: `linear-gradient(${c.inkLine}, transparent)`, opacity: cards * (1 - w1Away) }} />
        {f >= hold + 40 && (
          <div style={{ position: 'absolute', left: 120, top: 400, width: 560 }}>
            <Sticker text="RESTORED" at={hold + 40} size={72} />
            <div style={{ height: 40 }} />
            <FocusIn at={hold + 54}><Body color={c.white} size={30}>Restored without re-entering credentials.</Body></FocusIn>
            <div style={{ height: 28 }} />
            <FocusIn at={hold + 66}><ToolChip tool="session_start" detail="restoreState: true" dark /></FocusIn>
            <div style={{ height: 14 }} />
            <FocusIn at={hold + 74}><Body color={c.mutedOnInk} size={22}>0 credential fills in worker 2</Body></FocusIn>
          </div>
        )}
      </Ground>
    </Sweep>
  );
};

/* ───────────────────────── 5 · Cleanup (light) ───────────────────────── */
const Check: React.FC<{ at: number; text: string; detail: string }> = ({ at, text, detail }) => {
  const t = useIn(at, 16);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: t, transform: `translateX(${(1 - t) * 30}px)` }}>
      <svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="17" fill={c.teal} /><path d={`M10 17.5 l5 5 l9 -10`} stroke={c.ink} strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" strokeDashoffset={24 * (1 - t)} /></svg>
      <div>
        <div style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 28, color: c.ink }}>{text}</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 18, color: c.muted, marginTop: 2 }}>{detail}</div>
      </div>
    </div>
  );
};

const Cleanup: React.FC = () => {
  const f = useCurrentFrame();
  const refusedAt = 70; // hard cut to the refused login
  const zoom = useMove(40, 24);
  const frameW = 1060, frameH = 596;
  return (
    <Ground>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 640 }}>
        <FocusIn at={4}><Step n="03" label="Cleanup" /></FocusIn>
        <div style={{ height: 36 }} />
        <Headline text="Complete the task. Clean up." at={8} size={84} />
        <div style={{ height: 56 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <Check at={34} text="Account deleted on the site" detail="browser_click · Delete Account" />
          <Check at={refusedAt + 16} text="Same credentials refused" detail="“Your email or password is incorrect!”" />
          <Check at={refusedAt + 52} text="Local record and inbox deleted" detail="account_delete {deleteInbox: true}" />
          <Check at={refusedAt + 70} text="No sessions left" detail="session_status → []" />
        </div>
      </div>
      <div style={{ position: 'absolute', right: 110, top: 230 }}>
        <BrowserFrame url={f < 7 ? 'automationexercise.com' : f < refusedAt ? 'automationexercise.com/delete_account' : 'automationexercise.com/login'} width={frameW} height={frameH}>
          {f < 34 ? (
            <Footage src="footage/w2.mp4" kind="video" width={frameW} height={frameH} from={FULL} trimBefore={Math.round(7.62 * 30)} />
          ) : f < refusedAt ? (
            <Footage src="footage/w2_deleted.png" kind="still" width={frameW} height={frameH} from={FULL} to={R.deletedHead} t={zoom} />
          ) : f < refusedAt + 30 ? (
            <Sequence from={refusedAt} layout="none">
              <Footage src="footage/w2.mp4" kind="video" width={frameW} height={frameH} from={R.login} trimBefore={Math.round(16.42 * 30)}>
                <div style={{ position: 'absolute', left: 500, top: 312 }}><HiddenNote /></div>
              </Footage>
            </Sequence>
          ) : (
            <Footage src="footage/w2_refused.png" kind="still" width={frameW} height={frameH} from={R.login}>
              <div style={{ position: 'absolute', left: 500, top: 312 }}><HiddenNote /></div>
            </Footage>
          )}
        </BrowserFrame>
      </div>
    </Ground>
  );
};

/* ───────────────────────── 6 · End lockup ───────────────────────── */
const End: React.FC = () => {
  const t = useIn(0, 24);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${c.paper} 0%, ${c.paper} 45%, #CFF3E8 100%)` }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 34 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, opacity: t, filter: `blur(${(1 - t) * 16}px)`, transform: `scale(${mix(1.08, 1, t)})` }}>
          <Mark size={120} />
          <div style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 128, letterSpacing: '-0.045em', color: c.ink }}>AgentHarbor</div>
        </div>
        <FocusIn at={16}><Body size={38} color={c.ink} style={{ fontWeight: 500 }}>An MCP toolkit for stateful browser automation.</Body></FocusIn>
        <FocusIn at={30}><div style={{ fontFamily: fonts.mono, fontSize: 28, color: c.tealDeep, marginTop: 10 }}>github.com/katsdivi/agentharbor</div></FocusIn>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const ProductFilm: React.FC = () => {
  const f = useCurrentFrame();
  const darkAct = (f >= T.signup && f < T.session + 11) || (f >= T.hero + 11 && f < T.cleanup);
  const ctx = f < 60 ? interpolate(f, [30, 60], [0, 1], { extrapolateLeft: 'clamp' }) : f >= T.end ? interpolate(f, [T.end, T.end + 10], [1, 0], { extrapolateRight: 'clamp' }) : 1;
  return (
    <AbsoluteFill style={{ background: c.paper }}>
      <Sequence from={T.open} durationInFrames={T.signup - T.open + 6}><Opening /></Sequence>
      <Sequence from={T.signup - 6} durationInFrames={T.session - T.signup + 6 + TAIL}><Signup /></Sequence>
      <Sequence from={T.session} durationInFrames={T.hero - T.session + TAIL}><Session /></Sequence>
      <Sequence from={T.hero} durationInFrames={T.cleanup - T.hero}><Hero /></Sequence>
      <Sequence from={T.cleanup} durationInFrames={T.end - T.cleanup}><Cleanup /></Sequence>
      <Sequence from={T.end} durationInFrames={T.total - T.end}><End /></Sequence>
      <ContextBar dark={darkAct} opacity={ctx} />
    </AbsoluteFill>
  );
};

export const POSTER_FRAME = T.hero + 220;
export { ease, H };
