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
const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || '').trim().toLowerCase();
const MAIL_FROM = process.env.MAIL_FROM || 'Stooge Quote Club <quotes@stooges.zcureit.net>';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '';
const MAIL_ENDPOINT = process.env.MAIL_ENDPOINT || '';
const SMTP_URL = process.env.SMTP_URL || '';
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY || '';
const MAILERSEND_ENDPOINT = process.env.MAILERSEND_ENDPOINT || 'https://api.mailersend.com/v1/email';
const MAILERSEND_FROM_EMAIL = process.env.MAILERSEND_FROM_EMAIL || MAIL_FROM;
const MAILERSEND_FROM_NAME = process.env.MAILERSEND_FROM_NAME || MAIL_FROM_NAME;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_ENDPOINT = MAIL_ENDPOINT || process.env.SENDGRID_ENDPOINT || 'https://api.sendgrid.com/v3/mail/send';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || MAIL_FROM;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || MAIL_FROM_NAME;
const TEST_SEND_PASSWORD = process.env.TEST_SEND_PASSWORD || '';

class MailProviderError extends Error {
  constructor(provider, status, body) {
    super(`${provider} rejected message (${status}): ${String(body || '').slice(0, 500)}`);
    this.name = 'MailProviderError';
    this.provider = provider;
    this.status = status;
    this.body = String(body || '');
  }
}

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

function publicSendError(error) {
  if (error instanceof MailProviderError) {
    if (error.body.includes('trial account unique recipients limit')) {
      return 'MailerSend rejected that recipient because this account has reached its trial unique-recipient limit. The email address format is valid, including dots.';
    }
    if (error.provider === 'SendGrid' && error.body.includes('Maximum credits exceeded')) {
      return 'SendGrid rejected the email because this account has exceeded its sending credits.';
    }
    return `${error.provider} rejected the email. Check the sending account settings or recipient restrictions.`;
  }
  return 'The email could not be sent yet.';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function quoteForToday() {
  const dayNumber = Math.floor(Date.now() / 86400000);
  return QUOTES[dayNumber % QUOTES.length];
}

function quoteHistoryFor(subscriber) {
  if (!subscriber || !Array.isArray(subscriber.sentQuoteIndexes)) return [];
  const seen = new Set();
  return subscriber.sentQuoteIndexes
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < QUOTES.length && !seen.has(index) && seen.add(index));
}

function selectQuoteForSubscriber(subscriber) {
  const history = quoteHistoryFor(subscriber);
  let available = QUOTES.map((_, index) => index).filter((index) => !history.includes(index));
  if (!available.length) available = QUOTES.map((_, index) => index);
  const quoteIndex = available[crypto.randomInt(available.length)];
  return { quote: QUOTES[quoteIndex], quoteIndex };
}

function recordQuoteSent(subscriber, quoteIndex) {
  if (!subscriber || !Number.isInteger(quoteIndex)) return;
  const history = quoteHistoryFor(subscriber);
  const nextHistory = history.includes(quoteIndex) ? history : [...history, quoteIndex];
  subscriber.sentQuoteIndexes = nextHistory.slice(-QUOTES.length);
  subscriber.lastQuoteIndex = quoteIndex;
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

function readBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function parseRequestBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
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
  let shouldSendSignupTest = false;
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
    shouldSendSignupTest = true;
  } else {
    subscriber.active = true;
    subscriber.updatedAt = now;
    subscriber.token ||= crypto.randomBytes(24).toString('hex');
    shouldSendSignupTest = !subscriber.signupTestSentAt;
  }
  writeSubscribers(subscribers);

  if (shouldSendSignupTest) {
    try {
      if (!mailIsConfigured()) throw new Error('Email service is not configured.');
      const message = signupTestMessage(subscriber);
      await sendMail(message);
      const updatedSubscribers = readSubscribers();
      const updatedSubscriber = updatedSubscribers.find((entry) => entry.email === email);
      if (updatedSubscriber) {
        recordQuoteSent(updatedSubscriber, message.quoteIndex);
        updatedSubscriber.signupTestSentAt = new Date().toISOString();
        updatedSubscriber.updatedAt = updatedSubscriber.signupTestSentAt;
        writeSubscribers(updatedSubscribers);
      }
    } catch (error) {
      console.error(`Signup test email failed for ${email}:`, error);
      return json(res, 503, { ok: false, error: `You were saved, but the test email could not be sent yet. ${publicSendError(error)}` });
    }
  }

  return json(res, 200, { ok: true, message: 'You are signed up for the daily Stooge quote.' });
}

async function handleTestSend(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' });
  let body;
  try {
    body = await parseRequestBody(req);
  } catch {
    return json(res, 400, { ok: false, error: 'Bad request body' });
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: 'Enter a valid email address.' });
  if (!TEST_SEND_PASSWORD || String(body.password || '') !== TEST_SEND_PASSWORD) {
    return json(res, 403, { ok: false, error: 'Enter the test password first.' });
  }

  try {
    if (!mailIsConfigured()) throw new Error('Email service is not configured.');
    const subscribers = readSubscribers();
    const subscriber = subscribers.find((entry) => entry.email === email && entry.active);
    const message = testSendMessage(email, subscriber);
    await sendMail(message);
    if (subscriber) {
      recordQuoteSent(subscriber, message.quoteIndex);
      subscriber.lastTestSentAt = new Date().toISOString();
      subscriber.updatedAt = subscriber.lastTestSentAt;
      writeSubscribers(subscribers);
    }
    return json(res, 200, { ok: true, message: 'Test email sent. Check that inbox.' });
  } catch (error) {
    console.error(`Manual test email failed for ${email}:`, error);
    return json(res, 503, { ok: false, error: publicSendError(error) });
  }
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

function wrapBase64(value) {
  return String(value).replace(/(.{76})/g, '$1\r\n');
}

async function sendSmtpMail({ to, subject, text, htmlBody, listUnsubscribe, attachments = [] }) {
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

  const alternativeBoundary = `stooge-alt-${crypto.randomBytes(12).toString('hex')}`;
  const mixedBoundary = `stooge-mix-${crypto.randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${MAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    listUnsubscribe ? `List-Unsubscribe: <${listUnsubscribe}>` : null,
    attachments.length
      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    ''
  ].filter((line) => line !== null);
  const alternativePart = [
    attachments.length ? `--${mixedBoundary}` : null,
    attachments.length ? `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"` : null,
    attachments.length ? '' : null,
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
    '',
    `--${alternativeBoundary}--`
  ].filter((line) => line !== null);
  const attachmentParts = attachments.flatMap((attachment) => [
    '',
    `--${mixedBoundary}`,
    `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    wrapBase64(attachment.content.toString('base64'))
  ]);
  const message = [
    ...headers,
    ...alternativePart,
    ...attachmentParts,
    attachments.length ? `--${mixedBoundary}--` : null,
    '.'
  ].filter((line) => line !== null).join('\r\n');
  socket.write(`${message}\r\n`);
  await smtpRead(socket);
  await smtpCommand(socket, 'QUIT', /^[23]/).catch(() => {});
  socket.end();
}

function mailerSendIsConfigured() {
  return Boolean(MAILERSEND_API_KEY && MAILERSEND_FROM_EMAIL && MAILERSEND_FROM_NAME);
}

function sendGridIsConfigured() {
  return Boolean(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL);
}

function mailIsConfigured() {
  if (MAIL_PROVIDER === 'sendgrid') return sendGridIsConfigured();
  if (MAIL_PROVIDER === 'mailersend') return mailerSendIsConfigured();
  if (MAIL_PROVIDER === 'smtp') return Boolean(SMTP_URL);
  return sendGridIsConfigured() || mailerSendIsConfigured() || Boolean(SMTP_URL);
}

async function sendMailerSendMail({ to, subject, text, htmlBody, listUnsubscribe, attachments = [] }) {
  if (!mailerSendIsConfigured()) throw new Error('MailerSend is not configured');
  const payload = {
    from: {
      email: MAILERSEND_FROM_EMAIL,
      name: MAILERSEND_FROM_NAME
    },
    to: [{ email: to }],
    subject,
    text,
    html: htmlBody
  };

  // MailerSend custom headers require a paid plan; the unsubscribe URL stays in the email body.
  void listUnsubscribe;

  if (attachments.length) {
    payload.attachments = attachments.map((attachment) => ({
      content: attachment.content.toString('base64'),
      filename: attachment.filename,
      disposition: 'attachment'
    }));
  }

  const response = await fetch(MAILERSEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MAILERSEND_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new MailProviderError('MailerSend', response.status, body);
  }
}

async function sendSendGridMail({ to, subject, text, htmlBody, listUnsubscribe, attachments = [] }) {
  if (!sendGridIsConfigured()) throw new Error('SendGrid is not configured');
  const personalization = {
    to: [{ email: to }]
  };
  if (listUnsubscribe) {
    personalization.headers = {
      'List-Unsubscribe': `<${listUnsubscribe}>`
    };
  }

  const payload = {
    personalizations: [personalization],
    from: {
      email: SENDGRID_FROM_EMAIL,
      ...(SENDGRID_FROM_NAME ? { name: SENDGRID_FROM_NAME } : {})
    },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: htmlBody }
    ]
  };

  if (attachments.length) {
    payload.attachments = attachments.map((attachment) => ({
      content: attachment.content.toString('base64'),
      filename: attachment.filename,
      type: attachment.contentType || 'application/octet-stream',
      disposition: 'attachment'
    }));
  }

  const response = await fetch(SENDGRID_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new MailProviderError('SendGrid', response.status, body);
  }
}

async function sendMail(message) {
  if (MAIL_PROVIDER === 'sendgrid') return sendSendGridMail(message);
  if (MAIL_PROVIDER === 'mailersend') return sendMailerSendMail(message);
  if (MAIL_PROVIDER === 'smtp') return sendSmtpMail(message);
  if (sendGridIsConfigured()) return sendSendGridMail(message);
  if (mailerSendIsConfigured()) return sendMailerSendMail(message);
  return sendSmtpMail(message);
}

function signupTestMessage(subscriber) {
  const { quote, quoteIndex } = selectQuoteForSubscriber(subscriber);
  const unsubscribeUrl = `${BASE_URL}/api/stooge-quotes/unsubscribe?token=${subscriber.token}`;
  return {
    to: subscriber.email,
    quoteIndex,
    subject: 'You are signed up for daily Stooge mail',
    text: [
      'You are signed up for the daily Stooge email.',
      '',
      'Here is a test quote so we know the mail cannon is aimed right:',
      `"${quote.text}"`,
      `- ${quote.author}`,
      '',
      `Visit the fansite: ${BASE_URL}/`,
      '',
      `Unsubscribe: ${unsubscribeUrl}`,
      ''
    ].join('\n'),
    htmlBody: [
      '<p style="font-size:18px;font-weight:700">You are signed up for the daily Stooge email.</p>',
      '<p>Here is a test quote so we know the mail cannon is aimed right:</p>',
      `<p style="font-size:20px;font-weight:700">&ldquo;${escapeHtml(quote.text)}&rdquo;</p>`,
      `<p>- ${escapeHtml(quote.author)}</p>`,
      `<p><a href="${BASE_URL}/">Visit the fansite</a></p>`,
      `<p style="font-size:12px;color:#666"><a href="${unsubscribeUrl}">Unsubscribe from daily Stooge quotes</a></p>`
    ].join(''),
    listUnsubscribe: unsubscribeUrl
  };
}

function testSendMessage(email, subscriber) {
  const { quote, quoteIndex } = selectQuoteForSubscriber(subscriber);
  const unsubscribeUrl = subscriber ? `${BASE_URL}/api/stooge-quotes/unsubscribe?token=${subscriber.token}` : '';
  const text = [
    'This is a manual test of the daily Stooge email sender.',
    '',
    `"${quote.text}"`,
    `- ${quote.author}`,
    '',
    `Visit the fansite: ${BASE_URL}/`,
    unsubscribeUrl ? '' : null,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : null,
    ''
  ].filter((line) => line !== null).join('\n');
  const htmlBody = [
    '<p style="font-size:18px;font-weight:700">This is a manual test of the daily Stooge email sender.</p>',
    `<p style="font-size:20px;font-weight:700">&ldquo;${escapeHtml(quote.text)}&rdquo;</p>`,
    `<p>- ${escapeHtml(quote.author)}</p>`,
    `<p><a href="${BASE_URL}/">Visit the fansite</a></p>`,
    unsubscribeUrl ? `<p style="font-size:12px;color:#666"><a href="${unsubscribeUrl}">Unsubscribe from daily Stooge quotes</a></p>` : ''
  ].join('');

  return {
    to: email,
    quoteIndex,
    subject: 'Manual test: daily Stooge email',
    text,
    htmlBody,
    listUnsubscribe: unsubscribeUrl
  };
}

function dailyQuoteMessage(subscriber) {
  const { quote, quoteIndex } = selectQuoteForSubscriber(subscriber);
  const unsubscribeUrl = `${BASE_URL}/api/stooge-quotes/unsubscribe?token=${subscriber.token}`;
  const text = `"${quote.text}"\n- ${quote.author}\n\nWatch more Stooges: ${BASE_URL}/#videos\n\nUnsubscribe: ${unsubscribeUrl}\n`;
  const htmlBody = `<p style="font-size:20px;font-weight:700">&ldquo;${escapeHtml(quote.text)}&rdquo;</p><p>- ${escapeHtml(quote.author)}</p><p><a href="${BASE_URL}/#videos">Watch more Stooges</a></p><p style="font-size:12px;color:#666"><a href="${unsubscribeUrl}">Unsubscribe from daily Stooge quotes</a></p>`;
  return {
    to: subscriber.email,
    quoteIndex,
    subject: 'Your daily Stooge quote',
    text,
    htmlBody,
    listUnsubscribe: unsubscribeUrl
  };
}

async function sendDailyQuotes() {
  ensureDataFile();
  const subscribers = readSubscribers();
  const date = todayKey();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  if (!mailIsConfigured()) {
    console.log('Mail provider is not configured; daily Stooge quote email not sent.');
    return { sent, skipped: subscribers.filter((entry) => entry.active).length };
  }

  for (const subscriber of subscribers) {
    if (!subscriber.active || subscriber.lastSentDate === date) {
      skipped += 1;
      continue;
    }
    const message = dailyQuoteMessage(subscriber);
    try {
      await sendMail(message);
      recordQuoteSent(subscriber, message.quoteIndex);
      subscriber.lastSentDate = date;
      subscriber.lastSendError = '';
      subscriber.updatedAt = new Date().toISOString();
      sent += 1;
    } catch (error) {
      failed += 1;
      subscriber.lastSendError = String(error.message || error).slice(0, 500);
      subscriber.updatedAt = new Date().toISOString();
      console.error(`Daily Stooge quote failed for ${subscriber.email}:`, error);
    }
  }
  writeSubscribers(subscribers);
  console.log(`Daily Stooge quotes complete: sent=${sent} skipped=${skipped} failed=${failed}`);
  return { sent, skipped, failed };
}

async function handleStoogeSnapSend(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required' });
  let body;
  try {
    body = await parseRequestBody(req, 7 * 1024 * 1024);
  } catch {
    return json(res, 400, { ok: false, error: 'Bad request body' });
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: 'Enter a valid email address.' });

  const imageData = String(body.imageData || '');
  const match = imageData.match(/^data:image\/png;base64,([a-z0-9+/=]+)$/i);
  if (!match) return json(res, 400, { ok: false, error: 'Take a Curly portrait first.' });

  const image = Buffer.from(match[1], 'base64');
  if (!image.length || image.length > 5 * 1024 * 1024) {
    return json(res, 400, { ok: false, error: 'That portrait is too large to email.' });
  }
  if (!mailIsConfigured()) return json(res, 503, { ok: false, error: 'Email service is not configured.' });

  const text = [
    'Your Curly Camera Booth portrait is attached.',
    '',
    `Make another one: ${BASE_URL}/#curlycam`,
    ''
  ].join('\n');
  const htmlBody = [
    '<p style="font-size:18px;font-weight:700">Your Curly Camera Booth portrait is attached.</p>',
    `<p><a href="${BASE_URL}/#curlycam">Make another one</a></p>`
  ].join('');

  await sendMail({
    to: email,
    subject: 'Your Curly Camera Booth portrait',
    text,
    htmlBody,
    attachments: [{
      filename: 'curly-camera-booth.png',
      contentType: 'image/png',
      content: image
    }]
  });

  return json(res, 200, { ok: true, message: 'Sent. Check that inbox for a Curly surprise.' });
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
      if (url.pathname === '/api/stooge-quotes/test-send') return handleTestSend(req, res);
      if (url.pathname === '/api/stooge-quotes/unsubscribe') return handleUnsubscribe(req, res);
      if (url.pathname === '/api/stooge-snaps/send') return handleStoogeSnapSend(req, res);
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
