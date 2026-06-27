#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const tls = require('tls');

const PORT = Number(process.env.PORT || 3195);
const DATA_DIR = process.env.STOOGE_MAIL_DATA_DIR || '/var/lib/stooges-mail';
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const BASE_URL = (process.env.BASE_URL || 'https://stooges.zcureit.net').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM || 'Stooge Quote Club <quotes@stooges.zcureit.net>';
const SMTP_URL = process.env.SMTP_URL || '';

const QUOTES = [
  { text: 'Take over. Raise your right hand.', author: 'Courtroom clip' },
  { text: "Now put your hand here. Raise your right hand.", author: 'Courtroom clip' },
  { text: "Raise your right hand. I don't mean that one.", author: 'Courtroom clip' },
  { text: 'Do you swear to tell the truth?', author: 'Courtroom clip' },
  { text: 'Address this court as Your Honor. Spread it out!', author: 'Courtroom clip' },
  { text: 'Your Honor? My honor? Not my honor!', author: 'Courtroom clip' },
  { text: 'Kindly speak English. Drop the vernacular.', author: 'Courtroom clip' },
  { text: 'We will show you just what happened.', author: 'Courtroom clip' }
];

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(SUBSCRIBERS_FILE)) {
    fs.writeFileSync(SUBSCRIBERS_FILE, '[]\n', { mode: 0o640 });
  }
}

function readSubscribers() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
}

function writeSubscribers(subscribers) {
  ensureDataFile();
  const tempFile = `${SUBSCRIBERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(subscribers, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tempFile, SUBSCRIBERS_FILE);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function quoteForToday() {
  const dayNumber = Math.floor(Date.now() / 86400000);
  return QUOTES[dayNumber % QUOTES.length];
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stooge Quote Club</title><style>body{font-family:system-ui,sans-serif;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0}.box{max-width:560px;padding:32px;border:1px solid #27272a;border-radius:24px;background:#18181b}a{color:#facc15}</style></head><body><main class="box">${body}</main></body></html>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function parseRequestBody(req) {
  const raw = await readBody(req);
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return JSON.parse(raw || '{}');
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

async function handleSubscribe(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' });
  let body;
  try {
    body = await parseRequestBody(req);
  } catch {
    return json(res, 400, { ok: false, error: 'Bad request body' });
  }

  if (body.website) return json(res, 200, { ok: true });
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: 'Enter a valid email address.' });

  const subscribers = readSubscribers();
  const now = new Date().toISOString();
  let subscriber = subscribers.find((entry) => entry.email === email);
  if (!subscriber) {
    subscriber = {
      email,
      token: crypto.randomBytes(24).toString('hex'),
      active: true,
      createdAt: now,
      updatedAt: now,
      lastSentDate: ''
    };
    subscribers.push(subscriber);
  } else {
    subscriber.active = true;
    subscriber.updatedAt = now;
    subscriber.token ||= crypto.randomBytes(24).toString('hex');
  }
  writeSubscribers(subscribers);
  return json(res, 200, { ok: true, message: 'You are signed up for the daily Stooge quote.' });
}

function unsubscribeByToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return false;
  const subscribers = readSubscribers();
  const subscriber = subscribers.find((entry) => entry.token === token);
  if (!subscriber) return false;
  subscriber.active = false;
  subscriber.updatedAt = new Date().toISOString();
  writeSubscribers(subscribers);
  return true;
}

async function handleUnsubscribe(req, res) {
  const url = new URL(req.url, BASE_URL);
  let token = url.searchParams.get('token') || '';
  if (req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      token = body.token || token;
    } catch {
      return json(res, 400, { ok: false, error: 'Bad request body' });
    }
  }
  const ok = unsubscribeByToken(token);
  if (req.method === 'POST') return json(res, ok ? 200 : 404, { ok, message: ok ? 'Unsubscribed.' : 'Unsubscribe link not found.' });
  return html(res, ok ? 200 : 404, ok
    ? '<h1>Nyuk-free inbox restored.</h1><p>You have been removed from the daily Stooge quote list.</p><p><a href="/">Back to the Stooges</a></p>'
    : '<h1>Unsubscribe link not found.</h1><p>This link may have already been used or copied incorrectly.</p><p><a href="/">Back to the Stooges</a></p>');
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk) => {
      data += chunk.toString('utf8');
      const lines = data.split(/\r?\n/).filter(Boolean);
      if (lines.length && /^\d{3} /.test(lines[lines.length - 1])) {
        cleanup();
        resolve(data);
      }
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expected.test(response)) throw new Error(`SMTP rejected ${command || 'greeting'}: ${response.trim()}`);
  return response;
}

function smtpAddress(fromHeader) {
  const match = String(fromHeader).match(/<([^>]+)>/);
  return match ? match[1] : String(fromHeader).trim();
}

async function sendSmtpMail({ to, subject, text, htmlBody, listUnsubscribe }) {
  if (!SMTP_URL) throw new Error('SMTP_URL is not configured');
  const parsed = new URL(SMTP_URL);
  const secure = parsed.protocol === 'smtps:';
  const port = Number(parsed.port || (secure ? 465 : 25));
  const host = parsed.hostname;
  const user = decodeURIComponent(parsed.username || '');
  const pass = decodeURIComponent(parsed.password || '');
  const fromAddress = smtpAddress(MAIL_FROM);
  const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('connect', () => { if (!secure) resolve(); });
    socket.once('error', reject);
  });

  await smtpCommand(socket, null);
  await smtpCommand(socket, `EHLO ${host}`);
  if (user || pass) {
    await smtpCommand(socket, 'AUTH LOGIN', /^334/);
    await smtpCommand(socket, Buffer.from(user).toString('base64'), /^334/);
    await smtpCommand(socket, Buffer.from(pass).toString('base64'), /^235/);
  }
  await smtpCommand(socket, `MAIL FROM:<${fromAddress}>`);
  await smtpCommand(socket, `RCPT TO:<${to}>`);
  await smtpCommand(socket, 'DATA', /^354/);

  const boundary = `stooge-${crypto.randomBytes(12).toString('hex')}`;
  const message = [
    `From: ${MAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    listUnsubscribe ? `List-Unsubscribe: <${listUnsubscribe}>` : null,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
    '.'
  ].filter((line) => line !== null).join('\r\n');
  socket.write(`${message}\r\n`);
  await smtpRead(socket);
  await smtpCommand(socket, 'QUIT', /^[23]/).catch(() => {});
  socket.end();
}

async function sendDailyQuotes() {
  ensureDataFile();
  const subscribers = readSubscribers();
  const date = todayKey();
  const quote = quoteForToday();
  let sent = 0;
  let skipped = 0;

  if (!SMTP_URL) {
    console.log('SMTP_URL is not configured; daily Stooge quote email not sent.');
    return { sent, skipped: subscribers.filter((entry) => entry.active).length };
  }

  for (const subscriber of subscribers) {
    if (!subscriber.active || subscriber.lastSentDate === date) {
      skipped += 1;
      continue;
    }
    const unsubscribeUrl = `${BASE_URL}/api/stooge-quotes/unsubscribe?token=${subscriber.token}`;
    const text = `"${quote.text}"\n- ${quote.author}\n\nWatch more Stooges: ${BASE_URL}/#videos\n\nUnsubscribe: ${unsubscribeUrl}\n`;
    const htmlBody = `<p style="font-size:20px;font-weight:700">&ldquo;${escapeHtml(quote.text)}&rdquo;</p><p>- ${escapeHtml(quote.author)}</p><p><a href="${BASE_URL}/#videos">Watch more Stooges</a></p><p style="font-size:12px;color:#666"><a href="${unsubscribeUrl}">Unsubscribe from daily Stooge quotes</a></p>`;
    await sendSmtpMail({
      to: subscriber.email,
      subject: 'Your daily Stooge quote',
      text,
      htmlBody,
      listUnsubscribe: unsubscribeUrl
    });
    subscriber.lastSentDate = date;
    subscriber.updatedAt = new Date().toISOString();
    sent += 1;
  }
  writeSubscribers(subscribers);
  console.log(`Daily Stooge quotes complete: sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function serve() {
  ensureDataFile();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, BASE_URL);
      if (url.pathname === '/api/stooge-quotes/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/stooge-quotes/subscribe') return handleSubscribe(req, res);
      if (url.pathname === '/api/stooge-quotes/unsubscribe') return handleUnsubscribe(req, res);
      return json(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      console.error(error);
      return json(res, 500, { ok: false, error: 'Stooge quote service had a pie-pan mishap.' });
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Stooge quote service listening on http://127.0.0.1:${PORT}`);
  });
}

const command = process.argv[2] || 'serve';
if (command === 'serve') {
  serve();
} else if (command === 'send-daily') {
  sendDailyQuotes().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 2;
}
