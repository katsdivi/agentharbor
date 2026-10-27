import React from 'react';
import { AbsoluteFill, Img, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import { c, ease, fonts, W, H } from './theme';

/** 0 → 1 over [start, start+dur] with the shared entrance curve. */
export const useIn = (start: number, dur = 18) => {
  const f = useCurrentFrame();
  return interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.out });
};
export const useMove = (start: number, dur: number) => {
  const f = useCurrentFrame();
  return interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.inOut });
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Focus-pull entrance: blur → sharp, slight rise. The film's primary reveal. */
export const FocusIn: React.FC<{ at: number; dur?: number; rise?: number; out?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, dur = 20, rise = 24, out, children, style }) => {
  const f = useCurrentFrame();
  const t = useIn(at, dur);
  const o = out === undefined ? 1 : interpolate(f, [out, out + 12], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.inOut });
  return (
    <div style={{ opacity: t * o, filter: `blur(${(1 - t) * 18 + (1 - o) * 14}px)`, transform: `translateY(${(1 - t) * rise}px)`, ...style }}>{children}</div>
  );
};

/** Headline set word by word with the focus-pull. */
export const Headline: React.FC<{ text: string; at: number; size?: number; color?: string; stagger?: number; weight?: number; out?: number; align?: 'left' | 'center' }> = ({ text, at, size = 96, color = c.text, stagger = 4, weight = 700, out, align = 'left' }) => (
  <div style={{ fontFamily: fonts.display, fontWeight: weight, fontSize: size, lineHeight: 1.02, letterSpacing: '-0.035em', color, textAlign: align, display: 'flex', flexWrap: 'wrap', justifyContent: align === 'center' ? 'center' : 'flex-start', columnGap: size * 0.24 }}>
    {text.split(' ').map((w, i) => (
      <FocusIn key={i} at={at + i * stagger} rise={size * 0.25} out={out}>
        {w}
      </FocusIn>
    ))}
  </div>
);

export const Body: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = c.muted, size = 30, style }) => (
  <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: size, color, letterSpacing: '-0.01em', lineHeight: 1.35, ...style }}>{children}</div>
);

/** Step label: "01 · Signup" with a teal dot. */
export const Step: React.FC<{ n: string; label: string; dark?: boolean }> = ({ n, label, dark }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontFamily: fonts.body, fontWeight: 600, fontSize: 22, letterSpacing: '0.08em', textTransform: 'uppercase', color: dark ? c.mutedOnInk : c.muted }}>
    <span style={{ width: 10, height: 10, borderRadius: 5, background: c.teal, boxShadow: `0 0 0 6px ${c.tealGlow}` }} />
    <span style={{ color: dark ? c.white : c.text }}>{n}</span>
    <span>{label}</span>
  </div>
);

/** A real tool call, set in mono inside a pill. Only names/arguments that occurred in the recorded run. */
export const ToolChip: React.FC<{ tool: string; detail?: string; dark?: boolean; status?: string }> = ({ tool, detail, dark, status }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, padding: '14px 22px', borderRadius: 999, background: dark ? c.inkSoft : c.white, border: `1px solid ${dark ? c.inkLine : c.line}`, boxShadow: dark ? 'none' : '0 10px 30px rgba(11,15,20,0.08)', fontFamily: fonts.mono, fontSize: 22, color: dark ? c.white : c.text, whiteSpace: 'nowrap' }}>
    <span style={{ color: c.teal }}>●</span>
    <span style={{ fontWeight: 600 }}>{tool}</span>
    {detail && <span style={{ color: dark ? c.mutedOnInk : c.muted }}>{detail}</span>}
    {status && <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 18, letterSpacing: '0.06em', textTransform: 'uppercase', color: c.tealDeep, background: 'rgba(34,201,160,0.14)', padding: '4px 10px', borderRadius: 999 }}>{status}</span>}
  </div>
);

/** Condensed uppercase sticker, slides in with a mask (after the primary reference's FAST/ACCURATE tags). */
export const Sticker: React.FC<{ text: string; at: number; rotate?: number; size?: number }> = ({ text, at, rotate = -3, size = 64 }) => {
  const t = useIn(at, 16);
  return (
    <div style={{ transform: `rotate(${rotate}deg)`, display: 'inline-block' }}>
      <div style={{ clipPath: `inset(0 ${(1 - t) * 100}% 0 0)`, background: c.teal, color: c.ink, fontFamily: fonts.sticker, fontWeight: 800, fontSize: size, letterSpacing: '0.02em', lineHeight: 1, padding: `${size * 0.16}px ${size * 0.3}px ${size * 0.1}px`, borderRadius: 8, boxShadow: '0 18px 40px rgba(34,201,160,0.25)' }}>{text}</div>
    </div>
  );
};

/** Small, quiet note attached to redacted fields. */
export const HiddenNote: React.FC<{ text?: string }> = ({ text = 'email hidden' }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: 'rgba(11,15,20,0.72)', color: c.white, fontFamily: fonts.body, fontWeight: 600, fontSize: 16, letterSpacing: '0.02em' }}>
    <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7" rx="2" fill="#fff" /><path d="M3 6V4.5a3 3 0 0 1 6 0V6" stroke="#fff" strokeWidth="1.6" fill="none" /></svg>
    {text}
  </div>
);

export type Rect = { x: number; y: number; w: number };

/**
 * Real footage (video or still) shown through a crop rectangle of the 1920x1080 source.
 * `from`/`to` are crop rects (x, y, width; height follows the viewport aspect); `t` blends them.
 */
export const Footage: React.FC<{
  src: string;
  kind: 'video' | 'still';
  width: number;
  height: number;
  from: Rect;
  to?: Rect;
  t?: number;
  trimBefore?: number;
  playbackRate?: number;
  children?: React.ReactNode;
}> = ({ src, kind, width, height, from, to, t = 0, trimBefore, playbackRate, children }) => {
  const r = to ? { x: mix(from.x, to.x, t), y: mix(from.y, to.y, t), w: mix(from.w, to.w, t) } : from;
  const s = width / r.w;
  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative', background: '#fff' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transformOrigin: '0 0', transform: `scale(${s}) translate(${-r.x}px, ${-r.y}px)` }}>
        {kind === 'video' ? (
          <OffthreadVideo src={staticFile(src)} trimBefore={trimBefore} playbackRate={playbackRate} muted style={{ width: W, height: H }} />
        ) : (
          <Img src={staticFile(src)} style={{ width: W, height: H }} />
        )}
        {children}
      </div>
    </div>
  );
};

/** Styled browser frame: quiet chrome, URL pill, optional speed badge. */
export const BrowserFrame: React.FC<{ url: string; width: number; height: number; badge?: string; dark?: boolean; dim?: number; children: React.ReactNode }> = ({ url, width, height, badge, dark, dim = 0, children }) => (
  <div style={{ width, borderRadius: 18, overflow: 'hidden', background: dark ? '#1A212B' : c.white, boxShadow: dark ? '0 40px 120px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)' : '0 40px 100px rgba(11,15,20,0.16), 0 0 0 1px rgba(11,15,20,0.06)', position: 'relative' }}>
    <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 9, background: dark ? '#1A212B' : '#F7F7F5', borderBottom: `1px solid ${dark ? '#262E3A' : '#E6E6E2'}` }}>
      {['#FF5F57', '#FEBC2E', '#28C840'].map((col) => (
        <span key={col} style={{ width: 13, height: 13, borderRadius: 7, background: dim ? '#5A6270' : col }} />
      ))}
      <div style={{ marginLeft: 24, flex: 1, maxWidth: 560, height: 32, borderRadius: 9, background: dark ? '#0F141B' : '#ECECE8', display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: fonts.body, fontSize: 17, color: dark ? c.mutedOnInk : c.muted }}>
        <span style={{ marginRight: 8, opacity: 0.7 }}>🔒︎</span>
        {url}
      </div>
      {badge && <div style={{ marginLeft: 'auto', fontFamily: fonts.body, fontWeight: 600, fontSize: 15, letterSpacing: '0.06em', color: dark ? c.mutedOnInk : c.muted, border: `1px solid ${dark ? '#323B48' : c.line}`, borderRadius: 999, padding: '4px 12px' }}>{badge}</div>}
    </div>
    <div style={{ width, height, position: 'relative' }}>
      {children}
      {dim > 0 && <div style={{ position: 'absolute', inset: 0, background: `rgba(11,15,20,${0.55 * dim})`, backdropFilter: `grayscale(${dim})` }} />}
    </div>
  </div>
);

/** Persistent context labels (bottom corners). */
export const ContextBar: React.FC<{ dark: boolean; opacity: number }> = ({ dark, opacity }) => {
  const col = dark ? 'rgba(255,255,255,0.55)' : 'rgba(11,15,20,0.5)';
  const st: React.CSSProperties = { fontFamily: fonts.body, fontWeight: 500, fontSize: 18, letterSpacing: '0.02em', color: col };
  return (
    <AbsoluteFill style={{ opacity, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 64, bottom: 40, ...st }}>Demo: local mode · AutomationExercise</div>
      <div style={{ position: 'absolute', right: 64, bottom: 40, ...st, border: `1px solid ${col}`, borderRadius: 999, padding: '3px 12px', fontSize: 15, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Edited demo</div>
    </AbsoluteFill>
  );
};

/** Brand mark: rounded square with a harbor arc and a dot (original mark). */
export const Mark: React.FC<{ size: number; dark?: boolean }> = ({ size, dark }) => (
  <svg width={size} height={size} viewBox="0 0 100 100">
    <rect width="100" height="100" rx="26" fill={dark ? c.white : c.ink} />
    <path d="M26 46 A24 24 0 0 0 74 46" stroke={c.teal} strokeWidth="9" fill="none" strokeLinecap="round" />
    <line x1="50" y1="28" x2="50" y2="66" stroke={dark ? c.ink : c.white} strokeWidth="9" strokeLinecap="round" />
    <circle cx="50" cy="26" r="7" fill={dark ? c.ink : c.white} />
  </svg>
);

/** Light-sweep transition: a thin teal line crosses the frame and reveals the next scene (used only at act breaks). */
export const Sweep: React.FC<{ at: number; dur?: number; children: React.ReactNode }> = ({ at, dur = 20, children }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.inOut });
  if (f < at) return null;
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const x = p * 112 - 6;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ clipPath: `polygon(0 0, ${x}% 0, ${x - 6}% 100%, 0 100%)` }}>{children}</AbsoluteFill>
      {p < 1 && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${x - 3}%`, width: 4, background: c.teal, transform: 'skewX(-3.2deg)', boxShadow: `0 0 40px 12px ${c.tealGlow}` }} />
      )}
    </AbsoluteFill>
  );
};

/** Whip transition: the outgoing scene slides off with horizontal motion blur; the next slides in. */
export const whip = (f: number, at: number, dur = 12) => {
  const p = interpolate(f, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.inOut });
  const blur = Math.sin(p * Math.PI) * 60;
  return { p, blur };
};
