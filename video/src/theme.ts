import { Easing } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadInterTight } from '@remotion/google-fonts/InterTight';
import { loadFont as loadBarlow } from '@remotion/google-fonts/BarlowCondensed';

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export const fonts = {
  body: loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily,
  display: loadInterTight('normal', { weights: ['600', '700', '800'], subsets: ['latin'] }).fontFamily,
  sticker: loadBarlow('normal', { weights: ['800'], subsets: ['latin'] }).fontFamily,
  mono: 'Menlo, ui-monospace, monospace',
};

/** Two grounds (light paper, dark ink) and one accent, as in the primary reference's light/dark acts. */
export const c = {
  paper: '#F4F3EF',
  paperDeep: '#E9E8E2',
  ink: '#0B0F14',
  inkSoft: '#141A22',
  inkLine: '#232B36',
  text: '#0B0F14',
  muted: '#6B7380',
  mutedOnInk: '#8B95A3',
  line: '#D6D8DC',
  teal: '#22C9A0',
  tealDeep: '#0F8F72',
  tealGlow: 'rgba(34, 201, 160, 0.20)',
  white: '#FFFFFF',
};

/** One entrance curve and one move curve, used everywhere. */
export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
};

export const sec = (s: number) => Math.round(s * FPS);
