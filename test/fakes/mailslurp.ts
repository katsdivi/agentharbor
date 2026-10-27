/**
 * Fake MailSlurp REST API (subset used by the adapter) for deterministic tests.
 * Shapes follow MailSlurp's OpenAPI spec (InboxDto, EmailPreview, Email).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

interface StoredEmail {
  id: string;
  inboxId: string;
  to: string[];
  from: string;
  subject: string;
  body: any;
  createdAt: string;
  read: boolean;
  /** Return 500 from GET /emails/{id} (malformed/unfetchable message). */
  broken?: boolean;
}

export async function startFakeMailSlurp(apiKey = 'test-mailslurp-key') {
  const inboxes = new Map<string, { id: string; emailAddress: string; expiresAt: string | null; tags: string[] }>();
  const emails: StoredEmail[] = [];
  const state = { listCalls: 0, failListCalls: 0, createdInboxes: 0, /** next create: inbox IS created, but the call returns 500 */ createThenFail: false };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    if (req.headers['x-api-key'] !== apiKey) return send(res, 401, { message: 'unauthorized' });
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/inboxes' && req.method === 'POST') {
      const id = randomUUID();
      const inbox = {
        id,
        emailAddress: `${id.slice(0, 8)}@fake-mailslurp.test`,
        expiresAt: url.searchParams.get('expiresIn') ? new Date(Date.now() + Number(url.searchParams.get('expiresIn'))).toISOString() : null,
        tags: url.searchParams.getAll('tags'),
      };
      inboxes.set(id, inbox);
      state.createdInboxes++;
      if (state.createThenFail) {
        state.createThenFail = false;
        return send(res, 500, { message: 'simulated failure after the inbox was created' });
      }
      return send(res, 201, { ...inbox, createdAt: new Date().toISOString(), userId: 'u', favourite: false, readOnly: false, virtualInbox: false });
    }
    let m = /^\/inboxes\/([^/]+)\/emails$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      state.listCalls++;
      if (state.failListCalls > 0) {
        state.failListCalls--;
        return send(res, 500, { message: 'transient' });
      }
      const since = Date.parse(url.searchParams.get('since') ?? '1970-01-01');
      const list = emails
        .filter((e) => e.inboxId === m![1] && Date.parse(e.createdAt) >= since)
        .map((e) => ({ id: e.id, inboxId: e.inboxId, subject: e.subject, to: e.to, from: e.from, createdAt: e.createdAt, read: e.read }));
      return send(res, 200, list);
    }
    m = /^\/emails\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'DELETE') {
      const i = emails.findIndex((x) => x.id === m![1]);
      if (i < 0) return send(res, 404, {});
      emails.splice(i, 1);
      return send(res, 204);
    }
    if (m && req.method === 'GET') {
      const e = emails.find((x) => x.id === m![1]);
      if (!e) return send(res, 404, {});
      if (e.broken) return send(res, 500, { message: 'cannot parse' });
      e.read = true;
      return send(res, 200, { ...e, userId: 'u', teamAccess: false, updatedAt: e.createdAt, isHTML: /<a /i.test(String(e.body)) });
    }
    // Paginated listing. Deliberately IGNORES the tag filter, so the client's own
    // tag check is exercised (the live API's filter behaviour was not verifiable).
    if (url.pathname === '/inboxes/paginated' && req.method === 'GET') {
      const content = [...inboxes.values()].map((i) => ({ ...i, createdAt: new Date().toISOString() }));
      return send(res, 200, { content, totalElements: content.length, totalPages: 1, number: 0, size: content.length, last: true, first: true, empty: content.length === 0 });
    }
    m = /^\/inboxes\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'DELETE') {
      inboxes.delete(m[1]!);
      return send(res, 204);
    }
    send(res, 404, { message: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url,
    apiKey,
    inboxes,
    emails,
    state,
    inboxByAddress(addr: string) {
      return [...inboxes.values()].find((i) => i.emailAddress === addr);
    },
    /** Deliver a message to an inbox (by address). */
    deliver(to: string, msg: { from: string; subject: string; body: any; createdAt?: string; broken?: boolean; toOverride?: string[] }) {
      const inbox = [...inboxes.values()].find((i) => i.emailAddress === to);
      if (!inbox) throw new Error(`no inbox ${to}`);
      const e: StoredEmail = {
        id: randomUUID(),
        inboxId: inbox.id,
        to: msg.toOverride ?? [to],
        from: msg.from,
        subject: msg.subject,
        body: msg.body,
        createdAt: msg.createdAt ?? new Date().toISOString(),
        read: false,
        broken: msg.broken,
      };
      emails.push(e);
      return e.id;
    },
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}
export type FakeMailSlurp = Awaited<ReturnType<typeof startFakeMailSlurp>>;
