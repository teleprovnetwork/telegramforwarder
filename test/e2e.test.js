import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { webhookSecret } from '../src/web.js';

// Runs the real server against a local stand-in for api.telegram.org.

const TOKEN = '123:test';
const MAIN = -100111;
const STORAGE = '-100999';
const PORT = 3977;
const AUTH = `Basic ${Buffer.from('admin:pw').toString('base64')}`;
const base = `http://127.0.0.1:${PORT}`;

const telegram = { calls: [], pinned: null, lastDoc: null, files: new Map(), nextId: 1 };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function saveUpload(raw, contentType) {
  const data = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
  const file = data.get('document') ?? data.get('state');
  const fileId = `f${telegram.nextId++}`;
  telegram.files.set(fileId, await file.text());
  return { message_id: 500, document: { file_id: fileId, file_name: file.name } };
}

const mock = http.createServer(async (req, res) => {
  const raw = await readBody(req);

  if (req.url.startsWith('/file/')) {
    res.end(telegram.files.get(req.url.split('/').pop()));
    return;
  }

  const method = req.url.split('/').pop();
  const contentType = req.headers['content-type'] ?? '';
  const params = contentType.startsWith('multipart') ? {} : JSON.parse(raw.toString() || '{}');
  telegram.calls.push({ method, params });

  const reply = (result) => res.end(JSON.stringify({ ok: true, result }));

  switch (method) {
    case 'getMe':
      return reply({ id: 1, username: 'test_bot' });
    case 'getChat':
      if (params.chat_id === STORAGE) return reply({ id: STORAGE, pinned_message: telegram.pinned });
      return reply({ id: params.chat_id, title: `Title ${params.chat_id}` });
    case 'getFile':
      return reply({ file_path: params.file_id });
    case 'sendDocument':
      telegram.lastDoc = await saveUpload(raw, contentType);
      return reply(telegram.lastDoc);
    case 'pinChatMessage':
      telegram.pinned = telegram.lastDoc;
      return reply(true);
    case 'editMessageMedia':
      telegram.pinned = await saveUpload(raw, contentType);
      return reply(telegram.pinned);
    case 'forwardMessages':
      return reply(params.message_ids.map((id) => ({ message_id: id })));
    default:
      return reply(true);
  }
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarder-e2e-'));
const channelsFile = path.join(dir, 'channels.json');
const repoConfig = JSON.stringify({ main: String(MAIN), children: [] });
fs.writeFileSync(channelsFile, repoConfig);

let server;

async function startServer(dataDir) {
  server = spawn(process.execPath, ['src/index.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BOT_TOKEN: TOKEN,
      ADMIN_PASSWORD: 'pw',
      STORAGE_CHAT_ID: STORAGE,
      PUBLIC_URL: 'https://bot.example.com',
      PORT: String(PORT),
      TELEGRAM_API_BASE: `http://127.0.0.1:${mock.address().port}`,
      CHANNELS_FILE: channelsFile,
      DATA_DIR: dataDir,
      SEND_GAP_MS: '0',
    },
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${base}/ping`).then(
      (res) => res.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

const stopServer = () =>
  new Promise((resolve) => {
    server.once('exit', resolve);
    server.kill();
  });

const page = () => fetch(`${base}/`, { headers: { authorization: AUTH } }).then((res) => res.text());

const submit = (url, fields) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: AUTH, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

const webhook = (update, secret = webhookSecret(TOKEN)) =>
  fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });

async function until(check, label) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const forwards = () => telegram.calls.filter((call) => call.method === 'forwardMessages');

after(async () => {
  if (server?.exitCode === null) await stopServer();
  mock.close();
});

test('full flow, including a restart that wipes the disk', { timeout: 60_000 }, async () => {
  await startServer(path.join(dir, 'disk1'));

  // Webhook is registered with the secret
  const hook = telegram.calls.find((call) => call.method === 'setWebhook');
  assert.equal(hook.params.url, 'https://bot.example.com/telegram/webhook');
  assert.equal(hook.params.secret_token, webhookSecret(TOKEN));

  // Dashboard and webhook are protected; ping is public
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await webhook({}, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/ping`)).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const crossSite = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { authorization: AUTH, origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);

  // Channels are added through the UI; an invite link is rejected
  await submit('/channels/add', { links: 'https://t.me/kid_one\n@kid_two' });
  const rejected = await submit('/channels/add', { links: 'https://t.me/+secret' });
  assert.match(decodeURIComponent(rejected.headers.get('location')), /Invite links/);

  let html = await page();
  assert.match(html, /Title @kid_one/);
  assert.match(html, /Title @kid_two/);
  assert.equal(JSON.parse(fs.readFileSync(channelsFile, 'utf8')).children[0].chat, '@kid_one');

  // A bad JSON save leaves the file alone
  const badSave = await submit('/config', { json: '{ nope' });
  assert.match(decodeURIComponent(badSave.headers.get('location')), /Not saved/);
  assert.equal(JSON.parse(fs.readFileSync(channelsFile, 'utf8')).children.length, 2);

  // Posts arrive by webhook, and HTML in a post is escaped on the dashboard
  const chat = { id: MAIN, type: 'channel', title: 'Main' };
  for (let id = 1; id <= 12; id++) {
    const text = id === 1 ? '<script>alert(1)</script>' : `post ${id}`;
    assert.equal((await webhook({ channel_post: { message_id: id, chat, text } })).status, 200);
  }
  await webhook({
    my_chat_member: {
      chat: { id: -100555, type: 'channel', title: 'Private one' },
      new_chat_member: { status: 'administrator' },
    },
  });

  html = await page();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /Private one/);

  // Wait out the album settle delay, then send
  await new Promise((resolve) => setTimeout(resolve, 10_500));
  await submit('/run', {});
  await until(() => forwards().length === 2, 'forwards');

  assert.deepEqual(
    forwards().map((call) => call.params.chat_id),
    ['@kid_one', '@kid_two'],
  );
  assert.deepEqual(forwards()[0].params.message_ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(forwards()[0].params.from_chat_id, String(MAIN));

  // The backup reaches Telegram, then a restart wipes the disk
  const backedUp = () =>
    telegram.pinned && JSON.parse(telegram.files.get(telegram.pinned.document.file_id)).runs.length === 1;
  await until(backedUp, 'backup');
  await stopServer();
  fs.writeFileSync(channelsFile, repoConfig); // Render puts the repo's file back
  await startServer(path.join(dir, 'disk2')); // and the data folder is gone

  html = await page();
  assert.match(html, /Title @kid_one/, 'dashboard-added channels survive');
  assert.match(html, /class="value">2<\/span><span class="label">New posts waiting/, 'queue survives');
  assert.match(html, /class="value">10<\/span><span class="label">Old posts/, 'library survives');

  // The next run continues where the last one stopped
  telegram.calls.length = 0;
  await submit('/run', {});
  await until(() => forwards().length === 2, 'second forwards');
  assert.deepEqual(forwards()[0].params.message_ids, [11, 12]);

  // Later backups replace the pinned file in place
  await until(() => telegram.calls.some((call) => call.method === 'editMessageMedia'), 'in-place backup');
});
