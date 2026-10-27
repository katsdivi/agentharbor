/**
 * Verification email. DEMO_MAIL_MODE=smtp (default) delivers straight to the recipient
 * domain's MX like any mail server (same approach as fixture-actor/main.js);
 * DEMO_MAIL_MODE=outbox keeps messages in memory, shown at /dev/outbox, as a fallback
 * when the network blocks outbound SMTP.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

export const outbox = [];

function smtpSession(host, port, from, to, message) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 15_000 });
    let buf = '';
    let step = 0;
    const steps = [null, `EHLO ${from.split('@')[1]}`, `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', `${message.replace(/\r?\n\./g, '\r\n..')}\r\n.`, 'QUIT'];
    const expect = [220, 250, 250, 250, 354, 250, 221];
    const done = (ok, why) => {
      sock.destroy();
      resolve({ ok, why });
    };
    sock.on('timeout', () => done(false, `timeout at step ${step}`));
    sock.on('error', (e) => done(false, e.code || 'error'));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code !== expect[step] && !(step === 3 && code === 251)) return done(false, `step ${step} got ${code}`);
        step++;
        if (step >= steps.length) return done(true, 'sent');
        sock.write(`${steps[step]}\r\n`);
      }
    });
  });
}

export async function sendVerification({ to, name, code, link, mode, fromDomain }) {
  const subject = `Your Nimbus verification code is ${code}`;
  const html = `<p>Hi ${name},</p><p>Your Nimbus verification code is <b>${code}</b>.</p><p>Or confirm directly: <a href="${link}">Verify my email</a></p><p>This is a research demo site, not a real service.</p>`;
  if (mode === 'outbox') {
    outbox.unshift({ to, subject, html, at: new Date().toISOString() });
    outbox.length = Math.min(outbox.length, 50);
    return { ok: true, via: 'outbox' };
  }
  let mx = [];
  try {
    mx = (await dns.promises.resolveMx(to.split('@')[1])).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch (e) {
    return { ok: false, via: 'smtp', why: `mx lookup ${e.code || 'error'}` };
  }
  const from = `noreply@${fromDomain}`;
  const message = [
    `From: Nimbus <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${fromDomain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');
  let why = 'no mx';
  for (const port of [25, 2525]) {
    for (const host of mx) {
      const r = await smtpSession(host, port, from, to, message);
      if (r.ok) return { ok: true, via: `smtp ${host}:${port}` };
      why = r.why;
    }
  }
  return { ok: false, via: 'smtp', why };
}
