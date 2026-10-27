// Generates the README art in this folder: hand-written SVG with SMIL animation, system fonts, no scripts.
//   node assets/readme/generate.mjs
// Palette and type follow the product film (docs/demo/agentharbor-product-film.mp4): ink, paper, one teal.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const EASE = `calcMode="spline" keyTimes="0;1" keySplines="0.16 1 0.3 1"`;

const THEMES = {
  dark: { bg0: '#0B0F14', bg1: '#111821', card: '#141B24', cardLine: '#263040', line: '#3A4555', text: '#F4F3EF', muted: '#8B95A3', teal: '#22C9A0', tealText: '#22C9A0', glow: 'rgba(34,201,160,0.16)', page: '#FFFFFF', pageText: '#2B2F36', dim: '#4A5361' },
  light: { bg0: '#F7F6F2', bg1: '#EEEDE7', card: '#FFFFFF', cardLine: '#DADCDF', line: '#C3C7CD', text: '#0B0F14', muted: '#6B7380', teal: '#22C9A0', tealText: '#0F8F72', glow: 'rgba(34,201,160,0.18)', page: '#FFFFFF', pageText: '#2B2F36', dim: '#B4B9C0' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" font-family="${FONT}">\n<title>${esc(label)}</title>\n${body}\n</svg>\n`;
/** Fade + rise entrance, played once. */
const enter = (begin, inner, dy = 12) =>
  `<g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.7s" begin="${begin}s" fill="freeze"/><animateTransform attributeName="transform" type="translate" from="0 ${dy}" to="0 0" dur="0.7s" begin="${begin}s" fill="freeze" ${EASE}/>${inner}</g>`;
/** Opacity keyframes on a loop: [[time 0..1, value], ...]. */
const loopOpacity = (dur, frames) => {
  const fr = [];
  for (const [k, v] of frames) {
    const t = Math.min(1, Math.max(0, Math.round(k * 1000) / 1000));
    if (fr.length && t <= fr[fr.length - 1][0]) continue;
    fr.push([t, v]);
  }
  if (fr[0][0] !== 0) fr.unshift([0, fr[0][1]]);
  if (fr[fr.length - 1][0] !== 1) fr.push([1, fr[fr.length - 1][1]]);
  return `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" keyTimes="${fr.map((f) => f[0]).join(';')}" values="${fr.map((f) => f[1]).join(';')}"/>`;
};
const sparkle = (x, y, r, color, begin) =>
  `<path d="M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r}Z" fill="${color}" opacity="0.2"><animate attributeName="opacity" values="0.12;0.75;0.12" dur="3.4s" begin="${begin}s" repeatCount="indefinite"/></path>`;

/** The AgentHarbor mark: rounded square, teal harbor arc (drawn in), stem and dot. */
const mark = (x, y, s, t, begin = 0.1) => {
  const k = s / 100;
  return `<g transform="translate(${x} ${y}) scale(${k})">
  <rect width="100" height="100" rx="26" fill="${t === THEMES.dark ? '#F4F3EF' : '#0B0F14'}"/>
  <path d="M26 46 A24 24 0 0 0 74 46" stroke="#22C9A0" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="76" stroke-dashoffset="76"><animate attributeName="stroke-dashoffset" from="76" to="0" dur="1.1s" begin="${begin + 0.3}s" fill="freeze" ${EASE}/></path>
  <line x1="50" y1="28" x2="50" y2="66" stroke="${t === THEMES.dark ? '#0B0F14' : '#F4F3EF'}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="50" cy="26" r="7" fill="${t === THEMES.dark ? '#0B0F14' : '#F4F3EF'}"/>
</g>`;
};

const pill = (x, y, text, t, { mono = false, w } = {}) => {
  const width = w ?? Math.round(text.length * (mono ? 8.4 : 8.2) + 34);
  return `<g><rect x="${x}" y="${y}" width="${width}" height="32" rx="16" fill="${t.card}" stroke="${t.cardLine}"/><circle cx="${x + 16}" cy="${y + 16}" r="4" fill="${t.teal}"/><text x="${x + 28}" y="${y + 21}" font-size="14" ${mono ? `font-family="${MONO}"` : 'font-weight="600"'} fill="${t.text}">${esc(text)}</text></g>`;
};

/** Mini browser window. */
const browser = (x, y, w, h, t, url, inner = '', dim = false) => `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${t.card}" stroke="${t.cardLine}"/>
  ${['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => `<circle cx="${x + 20 + i * 15}" cy="${y + 19}" r="4.5" fill="${dim ? t.dim : c}"/>`).join('')}
  <rect x="${x + 70}" y="${y + 9}" width="${Math.min(w - 78, 230)}" height="20" rx="6" fill="${t === THEMES.dark ? '#0F141B' : '#EFEEEA'}"/>
  <text x="${x + 78}" y="${y + 23}" font-size="${w < 260 ? 9 : 11.5}" fill="${t.muted}">${esc(url)}</text>
  <rect x="${x + 1}" y="${y + 38}" width="${w - 2}" height="${h - 39}" rx="0" fill="${t.page}" opacity="${dim ? 0.35 : 1}"/>
  <rect x="${x + 1}" y="${y + h - 14}" width="${w - 2}" height="13" rx="13" fill="${t.page}" opacity="${dim ? 0.35 : 1}"/>
  ${inner}
</g>`;

/* ───────────── hero ───────────── */
function hero(t) {
  const W = 1200, H = 440;
  const L = 6; // loop length for the browser vignette
  const page = `
  <rect x="772" y="186" width="190" height="10" rx="5" fill="#E7E5DE"/>
  <rect x="772" y="206" width="300" height="8" rx="4" fill="#EFEEE9"/>
  <rect x="772" y="222" width="260" height="8" rx="4" fill="#EFEEE9"/>
  <g opacity="0">${loopOpacity(L, [[0, 0], [0.18, 0], [0.26, 1], [0.92, 1], [1, 0]])}
    <circle cx="784" cy="262" r="11" fill="#22C9A0"/><path d="M778.5 262.5 l4 4 l7 -8" stroke="#0B0F14" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="804" y="267" font-size="16" fill="${t.pageText}">Logged in as <tspan font-weight="700">Alex Demo</tspan></text>
  </g>
  <g opacity="0">${loopOpacity(L, [[0, 0], [0.36, 0], [0.42, 1], [0.92, 1], [1, 0]])}
    <g transform="rotate(-3 1010 330)"><rect x="930" y="306" width="160" height="46" rx="7" fill="#22C9A0"/><text x="1010" y="339" font-size="28" font-weight="800" text-anchor="middle" letter-spacing="1" fill="#0B0F14" font-family="'Barlow Condensed', 'Arial Narrow', ${FONT}" font-stretch="condensed">RESTORED</text></g>
  </g>
  <g>${loopOpacity(L, [[0, 1], [0.16, 1], [0.22, 0], [0.96, 0], [1, 1]])}
    <rect x="772" y="252" width="150" height="20" rx="6" fill="#EFEEE9"><animate attributeName="opacity" values="0.4;1;0.4" dur="1s" repeatCount="indefinite"/></rect>
  </g>`;
  const body = `<defs>
  <linearGradient id="hbg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${t.bg0}"/><stop offset="1" stop-color="${t.bg1}"/></linearGradient>
  <radialGradient id="hglow" cx="0.78" cy="1.05" r="0.6"><stop offset="0" stop-color="${t.glow}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
</defs>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="url(#hbg)"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="url(#hglow)"/>
<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="23.5" fill="none" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="6 6"/>
${sparkle(706, 70, 10, t.teal, 0)}${sparkle(1150, 410, 7, t.teal, 1.1)}${sparkle(630, 380, 6, t.teal, 2.2)}${sparkle(52, 400, 6, t.teal, 0.6)}
${enter(0.1, mark(72, 92, 92, t))}
${enter(0.25, `<text x="190" y="166" font-size="80" font-weight="800" letter-spacing="-3" fill="${t.text}">AgentHarbor</text>`, 14)}
${enter(0.45, `<text x="74" y="252" font-size="40" font-weight="700" letter-spacing="-1.2" fill="${t.tealText}">Give agents a place to work.</text>`, 14)}
${enter(0.6, `<text x="74" y="292" font-size="20" fill="${t.muted}">Browser sessions, accounts and saved logins as MCP tools</text>`)}
${enter(0.8, `${pill(74, 330, 'local', t, { mono: true })}${pill(156, 330, 'remote_direct', t, { mono: true })}${pill(305, 330, 'remote_proxy', t, { mono: true })}${pill(448, 330, 'encrypted vault', t)}`)}
${enter(0.5, `
  <text x="752" y="96" font-size="12" font-weight="700" letter-spacing="1.6" fill="${t.muted}">WORKER 2 · NEW PROCESS</text>
  <circle cx="976" cy="92" r="4" fill="${t.teal}"><animate attributeName="r" values="3.5;5.5;3.5" dur="1.8s" repeatCount="indefinite"/></circle>
  ${browser(752, 112, 380, 270, t, 'automationexercise.com', page)}`, 18)}
`;
  return svg(W, H, 'AgentHarbor: give agents a place to work. Browser sessions, accounts and persistent state as MCP tools for Claude Code.', body);
}

/* ───────────── divider ───────────── */
function divider() {
  const dots = [0, 1, 2].map((i) => `<circle cx="${582 + i * 18}" cy="14" r="4.5" fill="#22C9A0" opacity="${0.45 + i * 0.25}"><animate attributeName="r" values="4;6.2;4" dur="2.4s" begin="${i * 0.25}s" repeatCount="indefinite"/></circle>`).join('');
  return svg(1200, 28, 'Section divider', `<line x1="40" y1="14" x2="556" y2="14" stroke="#8B949E" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="6 6"><animate attributeName="stroke-dashoffset" from="0" to="24" dur="1.6s" repeatCount="indefinite"/></line>
<line x1="644" y1="14" x2="1160" y2="14" stroke="#8B949E" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="6 6"><animate attributeName="stroke-dashoffset" from="0" to="-24" dur="1.6s" repeatCount="indefinite"/></line>
${dots}`);
}

/* ───────────── lifecycle (how it works) ───────────── */
const ICONS = {
  signup: (c) => `<rect x="-11" y="-13" width="22" height="26" rx="4" fill="none" stroke="${c}" stroke-width="2.4"/><line x1="-5" y1="-4" x2="5" y2="-4" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><line x1="-5" y1="3" x2="5" y2="3" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`,
  login: (c) => `<rect x="-11" y="-3" width="22" height="16" rx="4" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M-6 -3 v-4 a6 6 0 0 1 12 0 v4" fill="none" stroke="${c}" stroke-width="2.4"/>`,
  save: (c) => `<ellipse cx="0" cy="-8" rx="11" ry="4.5" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M-11 -8 v16 a11 4.5 0 0 0 22 0 v-16" fill="none" stroke="${c}" stroke-width="2.4"/>`,
  restore: (c) => `<path d="M-10 2 a10 10 0 1 0 3 -9" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><path d="M-9 -12 l2 6 l6 -2" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  cleanup: (c) => `<path d="M-9 -7 h18 M-5 -7 v-4 h10 v4 M-7 -7 l1.5 18 h11 l1.5 -18" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
};
function lifecycle(t) {
  const W = 1200, H = 320, L = 7.5;
  const steps = [
    ['signup', 'Sign up', 'account_register'],
    ['login', 'Log in', 'browser_fill · secret'],
    ['save', 'Save state', 'session_save_state'],
    ['restore', 'Restore', 'session_start'],
    ['cleanup', 'Clean up', 'account_delete'],
  ];
  const xs = steps.map((_, i) => 140 + i * 230);
  const cy = 128;
  const nodes = steps.map(([icon, label, tool], i) => {
    const on = i / steps.length, off = on + 0.2;
    const hl = `<circle cx="0" cy="0" r="44" fill="none" stroke="${t.teal}" stroke-width="2.5" opacity="0">${loopOpacity(L, [[0, 0], [on, 0], [on + 0.02, 1], [off, 1], [off + 0.04, 0], [1, 0]])}</circle>`;
    return enter(Math.round((0.15 + i * 0.12) * 100) / 100, `<g transform="translate(${xs[i]} ${cy})">
      <circle cx="0" cy="0" r="44" fill="${t.card}" stroke="${t.cardLine}" stroke-width="1.5"/>${hl}
      <g>${ICONS[icon](t.text)}</g>
      <text x="0" y="78" font-size="19" font-weight="700" text-anchor="middle" fill="${t.text}">${i + 1} · ${label}</text>
      <text x="0" y="102" font-size="13" text-anchor="middle" font-family="${MONO}" fill="${t.muted}">${esc(tool)}</text>
    </g>`);
  }).join('\n');
  const track = `<line x1="${xs[0] + 44}" y1="${cy}" x2="${xs[4] - 44}" y2="${cy}" stroke="${t.line}" stroke-width="2" stroke-dasharray="6 7"><animate attributeName="stroke-dashoffset" from="0" to="-26" dur="1.4s" repeatCount="indefinite"/></line>`;
  const pulse = `<circle r="7" fill="${t.teal}" cx="${xs[0]}" cy="${cy}"><animate attributeName="cx" dur="${L}s" repeatCount="indefinite" values="${xs[0]};${xs[4]};${xs[4]}" keyTimes="0;0.9;1" calcMode="linear"/><animate attributeName="opacity" dur="${L}s" repeatCount="indefinite" keyTimes="0;0.04;0.86;0.9;1" values="0;1;1;0;0"/></circle>`;
  // Worker boundary: steps 1–3 run in worker 1, 4–5 in a new worker 2.
  const split = (xs[2] + xs[3]) / 2;
  const bracket = (x1, x2, label, color) => `<path d="M${x1} 262 v10 h${x2 - x1} v-10" fill="none" stroke="${color}" stroke-width="1.6"/><text x="${(x1 + x2) / 2}" y="298" font-size="13" font-weight="700" letter-spacing="1.4" text-anchor="middle" fill="${color}">${label}</text>`;
  const body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22" fill="${t.bg0}" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="6 6"/>
${track}
${pulse}
${nodes}
<line x1="${split}" y1="40" x2="${split}" y2="236" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="3 5"/>
${enter(0.9, `${bracket(xs[0] - 60, xs[2] + 60, 'WORKER 1', t.muted)}${bracket(xs[3] - 60, xs[4] + 60, 'WORKER 2 · NEW PROCESS, SAVED COOKIES', t.tealText)}`)}`;
  return svg(W, H, 'How it works: 1 sign up with account_register, 2 log in with stored credentials, 3 save the session, 4 restore it in a new worker process, 5 clean up the account and inbox.', body);
}

/* ───────────── restore card (dark, used in a two-column section) ───────────── */
function restoreCard() {
  const t = THEMES.dark, W = 600, H = 480, L = 5.5;
  const token = `<g><animateMotion dur="${L}s" repeatCount="indefinite" keyPoints="0;0;0.5;0.5;1;1" keyTimes="0;0.12;0.38;0.5;0.76;1" calcMode="linear" path="M134 276 C 134 300, 180 300, 236 300 L 364 300 C 420 300, 466 300, 466 276"/>
    <g>${loopOpacity(L, [[0, 0], [0.1, 1], [0.78, 1], [0.84, 0], [1, 0]])}<rect x="-38" y="-14" width="76" height="28" rx="14" fill="#22C9A0"/><text x="0" y="5" font-size="12.5" font-weight="700" text-anchor="middle" fill="#0B0F14">cookies</text></g></g>`;
  const w2page = `<g opacity="0">${loopOpacity(L, [[0, 0], [0.74, 0], [0.8, 1], [0.97, 1], [1, 0]])}
      <circle cx="392" cy="226" r="9" fill="#22C9A0"/><path d="M387.5 226.5 l3.2 3.2 l5.6 -6.4" stroke="#0B0F14" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="408" y="230" font-size="12.5" fill="${t.pageText}">Logged in as <tspan font-weight="700">Alex Demo</tspan></text></g>`;
  const body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22" fill="${t.bg0}" stroke="${t.cardLine}" stroke-width="1.5"/>
<text x="36" y="56" font-size="13" font-weight="700" letter-spacing="1.6" fill="${t.muted}">SESSION RESTORE · ILLUSTRATION OF THE RECORDED RUN</text>
<text x="36" y="96" font-size="30" font-weight="800" letter-spacing="-1" fill="${t.text}">A new browser. The session continues.</text>
<text x="40" y="146" font-size="11.5" font-weight="700" letter-spacing="1.2" fill="${t.muted}">WORKER 1 · CLOSED</text>
${browser(36, 154, 196, 120, t, 'automationexercise.com', `<rect x="52" y="210" width="120" height="8" rx="4" fill="#C9CDD3"/><rect x="52" y="226" width="150" height="8" rx="4" fill="#DDE0E4"/>`, true)}
<text x="368" y="146" font-size="11.5" font-weight="700" letter-spacing="1.2" fill="${t.text}">WORKER 2 · NEW PROCESS</text>
${browser(368, 154, 196, 120, t, 'automationexercise.com', w2page)}
<path d="M134 276 C 134 300, 180 300, 236 300 L 364 300 C 420 300, 466 300, 466 276" fill="none" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="4 6"/>
<rect x="236" y="276" width="128" height="48" rx="12" fill="${t.card}" stroke="#22C9A0" stroke-width="1.5"/>
<text x="300" y="297" font-size="13" font-weight="700" text-anchor="middle" fill="${t.text}">AgentHarbor vault</text>
<text x="300" y="314" font-size="11" text-anchor="middle" font-family="${MONO}" fill="${t.muted}">AES-256-GCM</text>
${token}
${pill(36, 352, 'session_save_state · 2 cookies, encrypted', t, { mono: true })}
${pill(36, 394, 'session_start · restoreState: true · 0 fills', t, { mono: true })}
<text x="36" y="456" font-size="12" fill="${t.muted}">Values from the 2026-10-27 run log (docs/demo/README.md).</text>`;
  return svg(W, H, 'Session restore, illustrated: worker 1 saves 2 cookies into the encrypted vault and closes; a new worker 2 starts with them and is logged in as Alex Demo with zero credential fills.', body);
}

const files = {
  'hero-dark.svg': hero(THEMES.dark),
  'hero-light.svg': hero(THEMES.light),
  'how-it-works-dark.svg': lifecycle(THEMES.dark),
  'how-it-works-light.svg': lifecycle(THEMES.light),
  'restore-card.svg': restoreCard(),
  'divider.svg': divider(),
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(OUT, name), content);
console.log(Object.keys(files).join('\n'));
