const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_IDS_PER_CALL = 100; // Bot API limit for forwardMessages/copyMessages
const ALBUM_SETTLE_MS = 10_000; // lets every photo of an album arrive before it is sent
const MAX_LIBRARY = 5000;
const MAX_RUNS = 100;

const MISSING_MESSAGE = /message.*(not found|to (forward|copy)|invalid)|MESSAGE_ID|no messages/i;

/** Random picks that favour the least-sent posts, so repeats come last. */
export function pickRandom(library, count) {
  const shuffled = [...library];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.sort((a, b) => a.sends - b.sends).slice(0, count);
}

/**
 * Groups posts into API calls. Each call takes one source chat and at most
 * 100 ids, in increasing order. An album is never split across two calls,
 * because Telegram would then post it as two separate albums.
 */
export function planCalls(items) {
  const calls = [];
  for (const item of [...items].sort((a, b) => a.ids[0] - b.ids[0])) {
    let call = calls.findLast((entry) => entry.from === item.from);
    if (!call || call.ids.length + item.ids.length > MAX_IDS_PER_CALL) {
      call = { from: item.from, ids: [] };
      calls.push(call);
    }
    call.ids.push(...item.ids);
  }
  for (const call of calls) call.ids.sort((a, b) => a - b);
  return calls;
}

export class Scheduler {
  constructor({ store, tg, gapMs = 1000 }) {
    this.store = store;
    this.tg = tg;
    this.gapMs = gapMs;
    this.running = false;
  }

  nextRunAt() {
    const { lastRunAt } = this.store.state;
    return lastRunAt + this.store.config.settings.intervalMinutes * 60_000;
  }

  /** Runs a batch if one is due. Safe to call as often as you like. */
  tick() {
    const { paused } = this.store.config.settings;
    if (paused || this.running || Date.now() < this.nextRunAt()) return;
    this.run().catch((err) => console.error('Run failed:', err));
  }

  async run({ manual = false } = {}) {
    const { store } = this;
    const { main, settings, children } = store.config;
    const targets = children.filter((child) => child.enabled);
    if (this.running || !main || targets.length === 0) return null;

    this.running = true;
    try {
      const { items, type } = this.#chooseItems(settings);
      store.state.lastRunAt = Date.now();

      if (items.length === 0) {
        store.save();
        return null;
      }

      const results = await this.#sendToAll(targets, items, settings.mode);
      const run = this.#recordRun({ type, manual, items, results });
      await store.flush();
      return run;
    } finally {
      this.running = false;
    }
  }

  #chooseItems(settings) {
    const { queue, library } = this.store.state;
    const settled = queue.filter((item) => Date.now() - item.addedAt >= ALBUM_SETTLE_MS);
    const fresh = settled.slice(0, settings.newPerRun);
    if (fresh.length > 0) return { items: fresh, type: 'new' };
    return { items: pickRandom(library, settings.randomPerRun), type: 'random' };
  }

  async #sendToAll(targets, items, mode) {
    const results = [];
    for (const [index, target] of targets.entries()) {
      if (index > 0) await sleep(this.gapMs);
      results.push(await this.#sendToOne(target, items, mode));
    }
    return results;
  }

  async #sendToOne(target, items, mode) {
    const stats = (this.store.state.channelStats[target.chat] ??= {
      delivered: 0,
      lastSentAt: 0,
      lastError: '',
      lastErrorAt: 0,
    });
    const expected = items.reduce((sum, item) => sum + item.ids.length, 0);

    try {
      const delivered = await this.#deliver(target.chat, items, mode);
      stats.delivered += delivered;
      stats.lastSentAt = Date.now();
      stats.lastError = '';
      return { name: target.name, chat: target.chat, ok: true, delivered, expected };
    } catch (err) {
      stats.lastError = err.message;
      stats.lastErrorAt = Date.now();
      return { name: target.name, chat: target.chat, ok: false, delivered: 0, expected, error: err.message };
    }
  }

  async #deliver(chat, items, mode) {
    const method = mode === 'copy' ? 'copyMessages' : 'forwardMessages';

    // Telegram sends the original post, so images, captions and caption
    // formatting all carry over without the bot handling them.
    let delivered = 0;
    for (const { from, ids } of planCalls(items)) {
      const sent = await this.tg.call(method, { chat_id: chat, from_chat_id: from, message_ids: ids });
      delivered += sent.length;
    }
    return delivered;
  }

  #recordRun({ type, manual, items, results }) {
    const { state } = this.store;
    const ok = results.filter((result) => result.ok).length;
    const picked = new Set(items);
    let note = '';

    if (ok > 0) {
      for (const item of items) {
        item.sends += 1;
        item.lastSentAt = Date.now();
      }
      if (type === 'new') {
        state.queue = state.queue.filter((item) => !picked.has(item));
        state.library.push(...items);
        state.library = state.library.slice(-MAX_LIBRARY);
      }
      // Telegram skips posts it can't send without returning an error.
      if (results.some((result) => result.ok && result.delivered < result.expected)) {
        note = "Telegram skipped some posts. They may be deleted, or not allowed to be sent. See 'Per channel'";
      }
    } else if (results.every((result) => MISSING_MESSAGE.test(result.error))) {
      // Every post in the batch was deleted from the main channel. Without
      // this they would sit at the front of the queue and block it forever.
      state.queue = state.queue.filter((item) => !picked.has(item));
      state.library = state.library.filter((item) => !picked.has(item));
      note = `Removed ${items.length} posts that no longer exist in the main channel`;
    } else if (type === 'new') {
      note = 'Every channel failed, so these posts stay in the queue for the next run';
    }

    const run = {
      at: Date.now(),
      type,
      manual,
      posts: items.length,
      ok,
      failed: results.length - ok,
      delivered: results.reduce((sum, result) => sum + result.delivered, 0),
      note,
      results,
    };
    state.runs = [run, ...state.runs].slice(0, MAX_RUNS);
    this.store.save();
    return run;
  }
}
