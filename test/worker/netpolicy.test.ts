import { describe, expect, it } from 'vitest';
// Built output (the worker is tested as built; run `npm --prefix actor run build` first).
import {
  checkHost,
  checkUrl,
  checkUrlSync,
  expandIpv6,
  globToRegExp,
  makePolicy,
  resourceHostAllowed,
  privateIpReason,
  safeUrlForLog,
} from '../../actor/dist/netpolicy.js';

const open = makePolicy({ allowedNavigationOrigins: ['*'], allowPrivateHosts: [] });
const noDns = async () => {
  throw new Error('no dns in this test');
};

describe('netpolicy: IP classification', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '192.88.99.1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
    '::127.0.0.1',
  ])('blocks %s', (ip) => {
    expect(privateIpReason(ip)).not.toBeNull();
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '203.0.113.7', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888', '192.88.100.1'])('allows %s', (ip) => {
    expect(privateIpReason(ip)).toBeNull();
  });

  it('expands IPv6 forms', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6('2001:db8::8:800:200c:417a')).toEqual([0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a]);
    expect(expandIpv6('not-an-ip')).toBeNull();
  });
});

describe('netpolicy: URLs', () => {
  const nav = { topLevelNavigation: true, lookup: noDns };
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/',
    'http://foo.localhost/',
    'http://LOCALHOST./',
    'http://metadata.google.internal/',
    'http://metadata/',
    'http://db.internal/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::1]:3000/',
    'http://0/',
    'file:///etc/passwd',
    'chrome://settings',
    'view-source:http://example.com/',
    'ftp://example.com/',
    'javascript:alert(1)',
  ])('blocks navigation to %s', async (u) => {
    const r = await checkUrl(open, u, nav);
    expect(r.ok).toBe(false);
  });

  it('allows public origins with "*" and enforces the allowlist otherwise', async () => {
    expect((await checkUrl(open, 'https://example.com/a?b=1', nav)).ok).toBe(true);
    const strict = makePolicy({ allowedNavigationOrigins: ['https://example.com'], allowPrivateHosts: [] });
    expect((await checkUrl(strict, 'https://example.com/x', nav)).ok).toBe(true);
    const r = await checkUrl(strict, 'https://evil.example.net/', nav);
    expect(r.ok).toBe(false);
    // Resources are origin-restricted too: only navigation + configured resource origins.
    const res = { topLevelNavigation: false, lookup: noDns };
    expect((await checkUrl(strict, 'https://cdn.example.org/x.js', res)).ok).toBe(false);
    expect((await checkUrl(strict, 'https://example.com/x.js', res)).ok).toBe(true);
    const withCdn = makePolicy({ allowedNavigationOrigins: ['https://example.com'], allowedSubresourceOrigins: ['https://cdn.example.org', 'https://*.gstatic.test'], allowPrivateHosts: [] });
    expect((await checkUrl(withCdn, 'https://cdn.example.org/x.js', res)).ok).toBe(true);
    expect((await checkUrl(withCdn, 'https://cdn.example.org/x.js', nav)).ok).toBe(false); // not navigable
    expect((await checkUrl(withCdn, 'https://fonts.gstatic.test/f.woff', res)).ok).toBe(true);
    expect((await checkUrl(withCdn, 'https://gstatic.test/f.woff', res)).ok).toBe(false); // wildcard = subdomains only
    expect((await checkUrl(withCdn, 'http://cdn.example.org/x.js', res)).ok).toBe(false); // scheme matters
    expect((await checkUrl(withCdn, 'wss://example.com/socket', res)).ok).toBe(true); // wss ~ https origin
    expect((await checkUrl(withCdn, 'wss://evil.example.net/socket', res)).ok).toBe(false);
    expect(resourceHostAllowed(withCdn, 'cdn.example.org', 443)).toBe(true);
    expect(resourceHostAllowed(withCdn, 'cdn.example.org', 8443)).toBe(false);
    expect(resourceHostAllowed(withCdn, 'evil.example.net', 443)).toBe(false);
    expect(resourceHostAllowed(open, 'anything.example', 443)).toBe(true); // explicit '*'
    // Egress check URL is exempt from the allowlist but not from the private block.
    expect(checkUrlSync(strict, 'https://api.apify.com/v2/browser-info', { topLevelNavigation: true, allowlistExemptUrl: 'https://api.apify.com/v2/browser-info' }).ok).toBe(true);
    expect(checkUrlSync(strict, 'http://127.0.0.1:9/ip', { topLevelNavigation: true, allowlistExemptUrl: 'http://127.0.0.1:9/ip' }).ok).toBe(false);
  });

  it('allowPrivateHosts is exact host or host:port', async () => {
    const p = makePolicy({ allowedNavigationOrigins: ['*'], allowPrivateHosts: ['127.0.0.1:4000', 'intranet.internal'] });
    expect((await checkUrl(p, 'http://127.0.0.1:4000/', nav)).ok).toBe(true);
    expect((await checkUrl(p, 'http://127.0.0.1:4001/', nav)).ok).toBe(false);
    expect((await checkUrl(p, 'http://intranet.internal/', nav)).ok).toBe(true);
    expect((await checkUrl(p, 'http://other.internal/', nav)).ok).toBe(false);
  });

  it('blocks hostnames that resolve to private addresses (any address)', async () => {
    const lookup = async (h: string) => (h === 'rebind.example' ? ['93.184.216.34', '10.0.0.5'] : ['93.184.216.34']);
    expect((await checkHost(open, 'rebind.example', 80, lookup)).ok).toBe(false);
    expect((await checkHost(open, 'fine.example', 80, lookup)).ok).toBe(true);
    const mapped = async () => ['::ffff:127.0.0.1'];
    expect((await checkHost(open, 'x.example', 80, mapped)).ok).toBe(false);
  });

  it('globs and log-safe URLs', () => {
    expect(globToRegExp('http://a.com/page/*').test('http://a.com/page/12')).toBe(true);
    expect(globToRegExp('http://a.com/page/*').test('http://a.com/other')).toBe(false);
    expect(safeUrlForLog('https://u:p@a.com/x?token=SECRET#h')).toBe('https://a.com/x?[query]');
  });
});

describe('URL scrubbing for logs', () => {
  it('hides token-like path segments and URLs inside error text', async () => {
    const { safeUrlForLog: s, scrubUrlsInText } = await import('../../actor/src/urlsafe.js');
    expect(s('https://a.com/confirm/Zq81kd02Lm9xP4tR7vB2')).toBe('https://a.com/confirm/[redacted]');
    expect(scrubUrlsInText('net::ERR at https://a.com/v/Zq81kd02Lm9xP4tR7vB2?t=1 failed')).toBe('net::ERR at https://a.com/v/[redacted]?[query] failed');
  });
});
