import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext, type Ctx } from '../../src/core/context.js';
import { MailSlurpClient } from '../../src/email/mailslurp.js';
import { createServer } from '../../src/mcp/server.js';
import { ApifyProvider } from '../../src/providers/apify.js';
import { startFakeApify, type FakeApify } from '../fakes/apify.js';
import { startFakeMailSlurp, type FakeMailSlurp } from '../fakes/mailslurp.js';
import { startFixtureSite } from '../fixtures/site.js';
import { startIpEcho } from '../fixtures/ipecho.js';
import { testConfig } from './ctx.js';

type Site = Awaited<ReturnType<typeof startFixtureSite>>;

export interface Harness {
  /** One-shot: called for the next signup the fixture site accepts. */
  onSignup: SignupHook | null;
  ctx: Ctx;
  site: Site;
  /** Second fixture site on another origin (not authorised). */
  other: Site;
  apify: FakeApify;
  mail: FakeMailSlurp;
  echo: { url: string; close(): Promise<void> };
  mcp: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any; raw: string; image?: string }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  vars?: Record<string, string>;
  proxyUrl?: string;
  autoVerifyEmail?: boolean;
  /** Extra fixture origins: added to RBA_ALLOWED_ORIGINS and RBA_ALLOW_PRIVATE_HOSTS. */
  extraOrigins?: string[];
  /** Extra fixture origins allowed as page resources only (RBA_SUBRESOURCE_ORIGINS; also private-host allowed). */
  resourceOrigins?: string[];
}

/** Per-test hook run when the fixture site accepts a signup (before it answers the submit). */
export type SignupHook = (email: string, origin: string) => void;

export async function startHarness(o: HarnessOptions = {}): Promise<Harness> {
  const mail = await startFakeMailSlurp();
  let siteRef: Site | null = null;
  const site = await startFixtureSite({
    onSignup: async (email, origin) => {
      const hook = harness.onSignup;
      harness.onSignup = null;
      hook?.(email, origin);
      if (o.autoVerifyEmail === false) return;
      const token = siteRef!.state.tokens.get(email);
      mail.deliver(email, {
        from: 'no-reply@127.0.0.1',
        subject: 'Verify your account',
        body: `<p>Welcome!</p><a href="${origin}/verify?token=${token}">Verify email</a>`,
      });
    },
  });
  siteRef = site;
  const other = await startFixtureSite();
  const echo = await startIpEcho();
  const apify = await startFakeApify({ proxyUrl: o.proxyUrl });
  const extra = o.extraOrigins ?? [];
  const res = o.resourceOrigins ?? [];
  const hosts = [site.origin, other.origin, echo.url, ...extra, ...res].map((u) => new URL(u).host);
  const cfg = testConfig({
    APIFY_TOKEN: apify.token,
    APIFY_ACTOR_ID: 'tester~remote-browser-worker',
    MAILSLURP_API_KEY: mail.apiKey,
    RBA_AUTHORIZED_TARGETS: site.origin,
    RBA_ALLOWED_ORIGINS: [site.origin, other.origin, ...extra].join(','),
    ...(res.length ? { RBA_SUBRESOURCE_ORIGINS: res.join(',') } : {}),
    RBA_ALLOW_PRIVATE_HOSTS: hosts.join(','),
    RBA_EGRESS_CHECK_URL: echo.url,
    RBA_EMAIL_WAIT_MAX_SECS: '20',
    RBA_MAX_CONCURRENT_SESSIONS: '4',
    RBA_MONTHLY_BUDGET_USD: '10',
    RBA_IDLE_TIMEOUT_SECS: '120',
    ...o.vars,
  });
  const provider = new ApifyProvider({ token: apify.token, actorId: 'tester~remote-browser-worker', apiBaseUrl: apify.url, allowInsecureContainerUrl: true, pollIntervalMs: 150, startupTimeoutMs: 60_000 });
  const ctx = buildContext({ cfg, provider, mail: new MailSlurpClient(mail.apiKey, mail.url) });

  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(b);

  const harness: Harness = {
    onSignup: null,
    ctx,
    site,
    other,
    apify,
    mail,
    echo,
    mcp,
    async call(name, args = {}) {
      const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> };
      const raw = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { isError: !!r.isError, data: JSON.parse(raw), raw, image: r.content.find((c) => c.type === 'image')?.data };
    },
    async close() {
      for (const id of ctx.sessions.ownedIds()) await ctx.sessions.close(id).catch(() => undefined);
      ctx.sessions.stopHeartbeat();
      await mcp.close();
      await apify.close();
      await mail.close();
      await site.close();
      await other.close();
      await echo.close();
      ctx.db.close();
    },
  };
  return harness;
}
