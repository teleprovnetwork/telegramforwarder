import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeChat, parseConfig } from '../src/channels.js';
import { handleUpdate } from '../src/ingest.js';
import { pickRandom, planCalls, Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { TelegramError } from '../src/telegram.js';

const MAIN_ID = -1001;

/** Records sends. `fail` maps chat -> error message. */
function fakeTelegram(fail = {}) {
  const sent = [];
  return {
    sent,
    call: async (method, params) => {
      if (method !== 'forwardMessages' && method !== 'copyMessages') return true;
      if (fail[params.chat_id]) {
        throw new TelegramError(method, 400, { error_code: 400, description: fail[params.chat_id] });
      }
      sent.push({ method, params, chat: params.chat_id, ids: params.message_ids, from: params.from_chat_id });
      return params.message_ids.map((id) => ({ message_id: id }));
    },
  };
}

function setup({ children = ['-1002', '-1003'], settings = {}, fail } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarder-'));
  const channelsFile = path.join(dir, 'channels.json');
  fs.writeFileSync(channelsFile, JSON.stringify({ main: String(MAIN_ID), settings, children }));
  const tg = fakeTelegram(fail);
  const store = new Store({ tg, storageChat: '', channelsFile, dataDir: path.join(dir, 'data') });
  const scheduler = new Scheduler({ store, tg, gapMs: 0 });
  return { store, tg, scheduler, channelsFile };
}

const post = (id, extra = {}) => ({
  channel_post: {
    message_id: id,
    chat: { id: MAIN_ID, type: 'channel', title: 'Main' },
    text: `post ${id}`,
    ...extra,
  },
});

/** Queues posts and ages them past the album settle delay. */
function addPosts(store, count, start = 1) {
  for (let id = start; id < start + count; id++) handleUpdate(post(id), store);
  for (const item of store.state.queue) item.addedAt = 0;
}

test('normalizeChat understands the ways a link gets pasted', () => {
  assert.equal(normalizeChat('https://t.me/mychannel'), '@mychannel');
  assert.equal(normalizeChat('t.me/mychannel/'), '@mychannel');
  assert.equal(normalizeChat('https://t.me/mychannel/123?single'), '@mychannel');
  assert.equal(normalizeChat(' @mychannel '), '@mychannel');
  assert.equal(normalizeChat('mychannel'), '@mychannel');
  assert.equal(normalizeChat('-1001234567890'), '-1001234567890');
  assert.equal(normalizeChat('https://t.me/c/1234567890/55'), '-1001234567890');
  assert.throws(() => normalizeChat('https://t.me/+abcDEF123'), /Invite links/);
  assert.throws(() => normalizeChat('https://t.me/joinchat/abc'), /Invite links/);
  assert.throws(() => normalizeChat('not a link'), /Not a valid/);
});

test('parseConfig accepts plain links, removes duplicates and rejects bad values', () => {
  const config = parseConfig({
    main: '@mainchan',
    children: ['https://t.me/kid_one', '@kid_one', { chat: '@kid_two', enabled: false }],
  });
  assert.deepEqual(
    config.children.map((c) => [c.chat, c.enabled]),
    [
      ['@kid_one', true],
      ['@kid_two', false],
    ],
  );
  assert.equal(config.settings.intervalMinutes, 60);
  assert.throws(() => parseConfig({ settings: { newPerRun: 0 } }), /newPerRun/);
  assert.throws(() => parseConfig({ settings: { mode: 'teleport' } }), /mode/);
  assert.throws(() => parseConfig({ main: '@mainchan', children: ['@mainchan'] }), /main channel/);
});

test('only real posts from the main channel are queued, once each', async () => {
  const { store } = setup();
  await store.load();

  handleUpdate(post(1), store);
  handleUpdate(post(1), store); // redelivered
  handleUpdate(post(2, { text: undefined, pinned_message: {} }), store); // service message
  handleUpdate(
    { channel_post: { message_id: 3, chat: { id: -999, type: 'channel', title: 'Other' }, text: 'x' } },
    store,
  );

  assert.deepEqual(
    store.state.queue.map((item) => item.ids),
    [[1]],
  );
  assert.equal(store.state.chats[-999].title, 'Other');
  await store.flush();
});

test('an album counts as one post and stays together', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'], settings: { newPerRun: 2 } });
  await store.load();

  for (const id of [11, 10, 12]) {
    handleUpdate(post(id, { text: undefined, photo: [{}], media_group_id: 'a' }), store);
  }
  handleUpdate(post(13), store);
  handleUpdate(post(14), store);
  for (const item of store.state.queue) item.addedAt = 0;

  assert.equal(store.state.queue.length, 3);
  await scheduler.run();
  assert.deepEqual(tg.sent[0].ids, [10, 11, 12, 13]); // album + one more, in order
});

const imagePost = (id, caption, extra = {}) =>
  post(id, { text: undefined, photo: [{ file_id: 'small' }, { file_id: 'large' }], caption, ...extra });

test('an image with a caption is queued as a photo with the caption as preview', async () => {
  const { store } = setup();
  await store.load();

  handleUpdate(imagePost(1, 'Big sale today'), store);

  assert.equal(store.state.queue[0].kind, 'photo');
  assert.equal(store.state.queue[0].preview, 'Big sale today');
  await store.flush();
});

test('a long caption preview never cuts an emoji in half', async () => {
  const { store } = setup();
  await store.load();

  handleUpdate(imagePost(1, `${'a'.repeat(79)}🔥🔥🔥`), store);

  const { preview } = store.state.queue[0];
  assert.equal(preview, `${'a'.repeat(79)}🔥`);
  assert.ok(preview.isWellFormed());
  await store.flush();
});

for (const [mode, method] of [
  ['forward', 'forwardMessages'],
  ['copy', 'copyMessages'],
]) {
  test(`${mode} mode sends image posts without touching the caption`, async () => {
    const { store, tg, scheduler } = setup({ children: ['-1002'], settings: { mode } });
    await store.load();
    handleUpdate(imagePost(1, 'Caption one'), store);
    handleUpdate(imagePost(2, 'Caption two'), store);
    for (const item of store.state.queue) item.addedAt = 0;

    const run = await scheduler.run();

    assert.equal(tg.sent[0].method, method);
    // Exactly these fields: anything like remove_caption would change the post.
    assert.deepEqual(tg.sent[0].params, { chat_id: '-1002', from_chat_id: String(MAIN_ID), message_ids: [1, 2] });
    assert.equal(run.delivered, 2);
    assert.equal(run.note, '');
  });
}

test('an album keeps its caption preview when the caption is not on the first photo', async () => {
  const { store } = setup();
  await store.load();

  handleUpdate(imagePost(1, undefined, { media_group_id: 'a' }), store);
  handleUpdate(imagePost(2, 'Caption on photo two', { media_group_id: 'a' }), store);

  assert.equal(store.state.queue.length, 1);
  assert.equal(store.state.queue[0].preview, 'Caption on photo two');
  await store.flush();
});

test('an album is held back while its photos are still arriving', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'] });
  await store.load();

  handleUpdate(imagePost(1, 'Album', { media_group_id: 'a' }), store);
  store.state.queue[0].addedAt = 0; // the first photo arrived long ago
  handleUpdate(imagePost(2, undefined, { media_group_id: 'a' }), store); // another just arrived

  await scheduler.run();
  assert.equal(tg.sent.length, 0);
  assert.equal(store.state.queue.length, 1);
  await store.flush();
});

test('albums are never split across API calls', () => {
  const album = (start) => ({ from: '-1', ids: Array.from({ length: 7 }, (_, i) => start + i) });
  const items = Array.from({ length: 20 }, (_, i) => album(i * 7 + 1)); // 140 messages

  const calls = planCalls(items);

  assert.deepEqual(
    calls.map((call) => call.ids.length),
    [98, 42],
  );
  assert.equal(calls[1].ids[0], 99); // starts on an album boundary
});

test('ids stay strictly increasing when posts overlap, and sources stay apart', () => {
  const calls = planCalls([
    { from: '-1', ids: [1, 3] },
    { from: '-1', ids: [2] },
    { from: '-2', ids: [5] },
  ]);

  assert.deepEqual(calls, [
    { from: '-1', ids: [1, 2, 3] },
    { from: '-2', ids: [5] },
  ]);
});

test('posts Telegram silently skips are flagged in the report', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'] });
  await store.load();
  addPosts(store, 3);
  tg.call = async () => [{ message_id: 1 }, { message_id: 2 }]; // 2 of 3 sent, no error

  const run = await scheduler.run();

  assert.equal(run.delivered, 2);
  assert.match(run.note, /skipped some posts/);
});

test('new posts go out in batches, oldest first, to every active channel', async () => {
  const { store, tg, scheduler } = setup({
    children: ['-1002', { chat: '-1003', enabled: false }, '-1004'],
  });
  await store.load();
  addPosts(store, 25);

  const run = await scheduler.run();

  assert.equal(run.type, 'new');
  assert.deepEqual(
    tg.sent.map((s) => s.chat),
    ['-1002', '-1004'],
  );
  assert.deepEqual(tg.sent[0].ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(tg.sent[0].from, String(MAIN_ID));
  assert.equal(store.state.queue.length, 15);
  assert.equal(store.state.library.length, 10);

  await scheduler.run();
  assert.equal(tg.sent[2].ids[0], 11);
});

test('an empty queue switches to 10 different random old posts', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'], settings: { newPerRun: 100 } });
  await store.load();
  addPosts(store, 30);
  await scheduler.run();
  tg.sent.length = 0;

  const run = await scheduler.run();

  assert.equal(run.type, 'random');
  assert.equal(new Set(tg.sent[0].ids).size, 10);
  assert.equal(store.state.library.length, 30); // random sends keep posts in the library
});

test('random runs use every old post before repeating any', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'], settings: { newPerRun: 100 } });
  await store.load();
  addPosts(store, 30);
  await scheduler.run();
  tg.sent.length = 0;

  for (let i = 0; i < 3; i++) await scheduler.run();

  assert.equal(new Set(tg.sent.flatMap((s) => s.ids)).size, 30);
});

test('pickRandom never returns more than exists', () => {
  assert.equal(pickRandom([{ sends: 1 }, { sends: 1 }], 10).length, 2);
  assert.equal(pickRandom([], 10).length, 0);
});

test('one broken channel is reported without affecting the others', async () => {
  const { store, tg, scheduler } = setup({
    fail: { '-1002': 'Forbidden: bot is not a member of the channel chat' },
  });
  await store.load();
  addPosts(store, 3);

  const run = await scheduler.run();

  assert.deepEqual([run.ok, run.failed], [1, 1]);
  assert.deepEqual(
    tg.sent.map((s) => s.chat),
    ['-1003'],
  );
  assert.equal(store.state.queue.length, 0);
  assert.match(store.state.channelStats['-1002'].lastError, /not a member/);
});

test('posts stay queued when every channel fails', async () => {
  const error = 'Bad Request: chat not found';
  const { store, scheduler } = setup({ fail: { '-1002': error, '-1003': error } });
  await store.load();
  addPosts(store, 3);

  const run = await scheduler.run();

  assert.equal(store.state.queue.length, 3);
  assert.match(run.note, /stay in the queue/);
});

test('posts deleted from the main channel do not block the queue', async () => {
  const error = 'Bad Request: message to forward not found';
  const { store, scheduler } = setup({ fail: { '-1002': error, '-1003': error } });
  await store.load();
  addPosts(store, 3);

  const run = await scheduler.run();

  assert.equal(store.state.queue.length, 0);
  assert.match(run.note, /no longer exist/);
});

test('nothing is consumed when there are no active channels', async () => {
  const { store, tg, scheduler } = setup({ children: [] });
  await store.load();
  addPosts(store, 3);

  assert.equal(await scheduler.run(), null);
  assert.equal(store.state.queue.length, 3);
  assert.equal(tg.sent.length, 0);
  await store.flush();
});

test('tick respects the interval and the pause switch', async () => {
  const { store, tg, scheduler } = setup({ children: ['-1002'], settings: { newPerRun: 1 } });
  await store.load();
  addPosts(store, 5);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  scheduler.tick();
  await settle();
  assert.equal(tg.sent.length, 1);

  scheduler.tick(); // an hour hasn't passed
  await settle();
  assert.equal(tg.sent.length, 1);

  store.state.lastRunAt = 0;
  store.config.settings.paused = true;
  scheduler.tick();
  await settle();
  assert.equal(tg.sent.length, 1);
  await store.flush();
});

test('editing channels.json by hand beats saved config, otherwise saved config wins', async () => {
  const { store, tg, channelsFile } = setup({ children: ['-1002'] });
  const original = fs.readFileSync(channelsFile, 'utf8');
  const dataDir = path.dirname(store.stateFile);
  await store.load();

  store.setConfig(parseConfig({ ...store.config, children: ['-1002', '-1009'] }));
  await store.flush();

  // Render resets the disk: repo version of the file, saved state restored.
  fs.writeFileSync(channelsFile, original);
  const restarted = new Store({ tg, storageChat: '', channelsFile, dataDir });
  await restarted.load();
  assert.equal(restarted.config.children.length, 2);
  await restarted.flush();

  // You edit the file in the repo and redeploy.
  fs.writeFileSync(channelsFile, JSON.stringify({ main: String(MAIN_ID), children: ['-1005'] }));
  const redeployed = new Store({ tg, storageChat: '', channelsFile, dataDir });
  await redeployed.load();
  assert.deepEqual(
    redeployed.config.children.map((c) => c.chat),
    ['-1005'],
  );
  await redeployed.flush();
});
