/**
 * Fixture for navigation-readiness tests: delayed content, slow and hanging
 * subresources, parser-blocking scripts, late API responses and third-party
 * references that the network policy refuses. Binds 127.0.0.1 on a random port.
 *
 * Hanging requests are held open until `releaseHangs()` or `close()`, so they
 * cannot exhaust the browser's per-host connection pool across tests.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReadinessSite {
  origin: string;
  url(path: string): string;
  /** Requests seen, "METHOD /path" (query stripped). */
  requests: string[];
  /** Bodies received by POST /js-upload. */
  uploads: Array<{ bytes: number }>;
  /** Number of requests currently held open by /hang. */
  hanging(): number;
  releaseHangs(): void;
  close(): Promise<void>;
}

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function page(title: string, head: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

/**
 * @param opts.resourceOrigin origin used for hanging/slow subresources (default: this site).
 *   Pass a second ReadinessSite's origin to put the slow resources on another host.
 */
export async function startReadinessSite(opts: { resourceOrigin?: () => string } = {}): Promise<ReadinessSite> {
  const requests: string[] = [];
  const uploads: Array<{ bytes: number }> = [];
  const held = new Set<http.ServerResponse>();
  let origin = '';
  const res0 = () => (opts.resourceOrigin ? opts.resourceOrigin() : origin);
  const ms = (u: URL, d: number) => Math.max(0, Math.min(60_000, Number(u.searchParams.get('ms') ?? d) || 0));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${u.pathname}`);
    const html = (body: string, head = '') => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(u.pathname, head, body));
    };
    switch (u.pathname) {
      case '/':
        return html('<h1 id="main">Readiness fixture</h1>');
      case '/delayed': {
        // Content rendered by script N ms after load (a client-rendered listing).
        const n = ms(u, 1500);
        return html(
          `<h1 id="main">Listing</h1><ul id="list"></ul>
<script>setTimeout(function(){var l=document.getElementById('list');for(var i=1;i<=3;i++){var li=document.createElement('li');li.className='item';li.textContent='Item '+i;l.appendChild(li);}var d=document.createElement('div');d.id='late';d.textContent='Ready now';document.body.appendChild(d);}, ${n});</script>`,
        );
      }
      case '/hang-img':
        // An optional image that never finishes: load never fires.
        return html(`<h1 id="main">Hanging image</h1><div class="item">A</div><img src="${res0()}/hang?k=img" alt="">`);
      case '/hang-async-script':
        return html(`<h1 id="main">Hanging async script</h1><script async src="${res0()}/hang?k=script"></script>`);
      case '/parser-block':
        // A parser-blocking script that never answers: DOMContentLoaded never fires,
        // but the content before it is already in the DOM.
        return html(`<div id="top">Content before the blocking script</div><script src="${res0()}/hang?k=sync"></script><div id="after">after</div>`);
      case '/slow-img': {
        const n = ms(u, 1500);
        return html(`<h1 id="main">Slow image</h1><img src="${res0()}/slow.png?ms=${n}" alt="">`);
      }
      case '/third-party': {
        // References to hosts outside the resource policy (refused without a connection).
        const ext = ['https://fonts.example-thirdparty.test', 'https://ads.example-thirdparty.test', 'https://beacon.example-thirdparty.test'];
        return html(
          `<h1 id="main">Third party</h1><img src="${ext[1]}/pixel.gif" alt=""><script async src="${ext[2]}/beacon.js"></script>`,
          `<link rel="stylesheet" href="${ext[0]}/css?family=x"><script src="${ext[1]}/ads.js"></script>`,
        );
      }
      case '/api-later': {
        const n = ms(u, 800);
        const status = Number(u.searchParams.get('status') ?? '200');
        return html(
          `<h1 id="main">API page</h1><div id="out"></div>
<script>setTimeout(function(){fetch('/api/data?status=${status}').then(function(r){return r.text()}).then(function(t){document.getElementById('out').textContent=t;});}, ${n});</script>`,
        );
      }
      case '/api/data': {
        const status = Number(u.searchParams.get('status') ?? '200');
        res.writeHead(status >= 100 && status < 600 ? status : 200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: status < 400 }));
      }
      case '/js-upload': {
        if (req.method === 'POST') {
          // Accept the multipart body; the confirmation renders by script 1 s later,
          // next to an optional image that never loads.
          let n = 0;
          req.on('data', (c: Buffer) => (n += c.length));
          req.on('end', () => {
            uploads.push({ bytes: n });
            html(
              `<h1>Processing</h1><img src="${res0()}/hang?k=confirm" alt="">
<script>setTimeout(function(){var d=document.createElement('div');d.id='done';d.textContent='Upload received';document.body.appendChild(d);}, 1000);</script>`,
            );
          });
          return;
        }
        // An upload widget rendered by script 1.5 s after the page arrives, plus an
        // optional image that never loads (load never fires).
        return html(
          `<h1>Portal</h1><div id="slot"></div><img src="${res0()}/hang?k=portal" alt="">
<script>setTimeout(function(){document.getElementById('slot').innerHTML='<form method="post" action="/js-upload" enctype="multipart/form-data"><input type="file" id="file" name="file"><button id="upload-submit" type="submit">Upload</button></form>';}, 1500);</script>`,
        );
      }
      case '/nav-to-hang':
        return html(`<a id="go" href="/hang-img">go</a><form id="f" action="/hang-img" method="get"><button id="submit" type="submit">Submit</button></form>`);
      case '/slow.png': {
        const n = ms(u, 1500);
        const t = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          res.end(PNG_1x1);
        }, n);
        res.on('close', () => clearTimeout(t));
        return;
      }
      case '/hang':
        held.add(res);
        res.on('close', () => held.delete(res));
        return; // never answers
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const releaseHangs = () => {
    for (const r of held) r.destroy();
    held.clear();
  };
  return {
    origin,
    url: (p) => origin + p,
    requests,
    uploads,
    hanging: () => held.size,
    releaseHangs,
    close: () =>
      new Promise<void>((r) => {
        releaseHangs();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
