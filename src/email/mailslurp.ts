import { RbaError } from '../core/errors.js';

export interface Inbox {
  id: string;
  emailAddress: string;
  expiresAt: string | null;
}

export interface EmailPreview {
  id: string;
  inboxId?: string;
  subject?: string | null;
  to: string[];
  from?: string | null;
  createdAt: string;
  read?: boolean;
}

export interface Email extends EmailPreview {
  body?: string | null;
  isHTML?: boolean | null;
  headers?: Record<string, string> | null;
}

/**
 * Minimal MailSlurp REST client (https://api.mailslurp.com, header x-api-key).
 * Endpoints verified against MailSlurp's published OpenAPI spec:
 *   POST /inboxes, GET /inboxes/{id}/emails, GET /emails/{id}, DELETE /emails/{id}, DELETE /inboxes/{id}.
 */
export class MailSlurpClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.mailslurp.com',
    private readonly f: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(30_000);
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${path}`, {
        method,
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw new RbaError('cancelled', 'email wait cancelled');
      throw new RbaError('provider_error', `MailSlurp unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new RbaError('config_missing', `MailSlurp rejected the API key (${res.status})`);
    if (res.status === 402 || res.status === 429) {
      throw new RbaError('quota_exhausted', `MailSlurp (provider) plan limit or rate limit reached (HTTP ${res.status}); this is the provider's limit, not the local cap`, { source: 'provider', status: res.status });
    }
    if (!res.ok) throw new RbaError('provider_error', `MailSlurp ${method} ${path.split('?')[0]} failed: ${res.status}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RbaError('provider_error', 'MailSlurp returned malformed JSON');
    }
  }

  async createInbox(o: { name: string; tags: string[]; expiresInMs?: number; useDomainPool?: boolean }): Promise<Inbox> {
    const q = new URLSearchParams({ name: o.name, inboxType: 'HTTP_INBOX' });
    for (const t of o.tags) q.append('tags', t);
    if (o.expiresInMs) q.set('expiresIn', String(o.expiresInMs));
    if (o.useDomainPool) q.set('useDomainPool', 'true');
    const r = await this.req<{ id: string; emailAddress: string; expiresAt?: string | null }>('POST', `/inboxes?${q}`);
    if (!r?.id || !r.emailAddress) throw new RbaError('provider_error', 'MailSlurp createInbox returned no inbox');
    return { id: r.id, emailAddress: r.emailAddress, expiresAt: r.expiresAt ?? null };
  }

  async listEmails(inboxId: string, sinceIso: string, signal?: AbortSignal): Promise<EmailPreview[]> {
    const q = new URLSearchParams({ since: sinceIso, sort: 'ASC', size: '50' });
    const r = await this.req<unknown>('GET', `/inboxes/${encodeURIComponent(inboxId)}/emails?${q}`, signal);
    if (!Array.isArray(r)) throw new RbaError('provider_error', 'MailSlurp listEmails returned a non-array');
    return r as EmailPreview[];
  }

  getEmail(emailId: string, signal?: AbortSignal): Promise<Email> {
    return this.req<Email>('GET', `/emails/${encodeURIComponent(emailId)}`, signal);
  }

  /**
   * Inboxes carrying `tag` (used to find an inbox created by a process that died
   * before recording it). Filters on each inbox's own `tags` as well, so it does
   * not depend on the server applying the `tag` query filter.
   */
  async findInboxesByTag(tag: string): Promise<Inbox[]> {
    const q = new URLSearchParams({ tag, size: '100', page: '0' });
    const r = await this.req<{ content?: Array<{ id: string; emailAddress: string; expiresAt?: string | null; tags?: string[] }> }>('GET', `/inboxes/paginated?${q}`);
    return (r?.content ?? []).filter((i) => Array.isArray(i.tags) && i.tags.includes(tag)).map((i) => ({ id: i.id, emailAddress: i.emailAddress, expiresAt: i.expiresAt ?? null }));
  }

  async deleteInbox(inboxId: string): Promise<void> {
    await this.req('DELETE', `/inboxes/${encodeURIComponent(inboxId)}`);
  }

  /** DELETE /emails/{emailId}: removes one message permanently. */
  async deleteEmail(emailId: string): Promise<void> {
    await this.req('DELETE', `/emails/${encodeURIComponent(emailId)}`);
  }

  /** Every message in an inbox, oldest first (pages forward by createdAt; bounded). */
  async listAllEmails(inboxId: string, maxPages = 40): Promise<EmailPreview[]> {
    const out = new Map<string, EmailPreview>();
    let since = new Date(0).toISOString();
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.listEmails(inboxId, since);
      let added = 0;
      for (const e of batch) {
        if (e && typeof e.id === 'string' && !out.has(e.id)) {
          out.set(e.id, e);
          added++;
        }
      }
      const last = batch[batch.length - 1]?.createdAt;
      if (batch.length < 50 || !added || !last || Date.parse(last) <= Date.parse(since)) break;
      since = last;
    }
    return [...out.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
}
