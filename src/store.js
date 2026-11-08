import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from './channels.js';
import { TelegramError } from './telegram.js';

const BACKUP_FILENAME = 'forwarder-state.json';
const SAVE_DELAY_MS = 5000;

const emptyState = () => ({
  savedAt: 0,
  queue: [], // new posts waiting for their first send
  library: [], // posts already sent, reused for random runs
  lastRunAt: 0,
  runs: [],
  channelStats: {},
  chats: {}, // every chat the bot has noticed, keyed by id
  config: null,
  configFileHash: '',
});

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

/**
 * Holds all bot state in memory, saved to data/state.json and, when a storage
 * chat is set, to a pinned file there. The file copy is what survives Render's
 * disk being wiped.
 */
export class Store {
  constructor({ tg, storageChat, channelsFile, dataDir }) {
    this.tg = tg;
    this.storageChat = storageChat;
    this.channelsFile = channelsFile;
    this.stateFile = path.join(dataDir, 'state.json');
    this.state = emptyState();
    this.config = null;
    this.backup = { messageId: null, at: 0, error: '' };
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  async load() {
    const local = this.#readLocal();
    const remote = await this.#readBackup();
    const newest = [local, remote].filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)[0];
    this.state = { ...emptyState(), ...newest };
    this.#loadConfig();
    this.save();
  }

  /**
   * channels.json wins when it differs from the version last seen, because
   * that means it was edited by hand. Otherwise the saved copy wins, which
   * keeps dashboard edits after Render resets the file to the repo's version.
   */
  #loadConfig() {
    const text = fs.readFileSync(this.channelsFile, 'utf8');
    const hash = sha1(text);
    const fileChanged = hash !== this.state.configFileHash;

    if (this.state.config && !fileChanged) {
      this.config = parseConfig(this.state.config);
      this.#writeChannelsFile();
    } else {
      this.config = parseConfig(JSON.parse(text));
      this.state.config = this.config;
      this.state.configFileHash = hash;
    }
  }

  #writeChannelsFile() {
    fs.writeFileSync(this.channelsFile, `${JSON.stringify(this.config, null, 2)}\n`);
  }

  setConfig(config) {
    this.config = config;
    this.state.config = config;
    this.#writeChannelsFile();
    this.save();
  }

  /** Marks state as changed; it is written a few seconds later. */
  save() {
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Writes pending changes now. Writes never overlap. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.writing = this.writing.then(() => this.#persist());
    return this.writing;
  }

  async #persist() {
    if (!this.dirty) return;
    this.dirty = false;
    this.state.savedAt = Date.now();
    const json = JSON.stringify(this.state);

    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(`${this.stateFile}.tmp`, json);
      fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) {
      console.error('Could not write local state:', err.message);
    }

    if (!this.storageChat) return;
    try {
      await this.#uploadBackup(json);
      this.backup.at = Date.now();
      this.backup.error = '';
    } catch (err) {
      console.error('Backup failed:', err.message);
      this.backup.error = err.message;
      this.save(); // try again on the next cycle
    }
  }

  async #uploadBackup(json) {
    const blob = new Blob([json], { type: 'application/json' });
    const chatId = this.storageChat;

    if (this.backup.messageId) {
      try {
        await this.tg.call(
          'editMessageMedia',
          {
            chat_id: chatId,
            message_id: this.backup.messageId,
            media: JSON.stringify({ type: 'document', media: 'attach://state' }),
          },
          { files: { state: [blob, BACKUP_FILENAME] } },
        );
        return;
      } catch (err) {
        if (/not modified/i.test(err.message)) return;
        if (!(err instanceof TelegramError) || err.code !== 400) throw err;
        // The pinned file was deleted, so fall through and post a new one.
      }
    }

    const message = await this.tg.call(
      'sendDocument',
      { chat_id: chatId, disable_notification: true },
      { files: { document: [blob, BACKUP_FILENAME] } },
    );
    await this.tg.call('pinChatMessage', {
      chat_id: chatId,
      message_id: message.message_id,
      disable_notification: true,
    });
    this.backup.messageId = message.message_id;
  }

  #readLocal() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async #readBackup() {
    if (!this.storageChat) return null;

    // Any failure that might be temporary must stop startup. Carrying on empty
    // would overwrite a good backup, so let Render restart the service instead.
    let pinned;
    try {
      const chat = await this.tg.call('getChat', { chat_id: this.storageChat });
      pinned = chat.pinned_message;
    } catch (err) {
      const badChat = err instanceof TelegramError && [400, 403].includes(err.code);
      if (!badChat) throw new Error(`Could not reach the storage chat: ${err.message}`);
      // A wrong chat id shouldn't lock you out of the dashboard, and nothing
      // can be overwritten because uploads to that chat will fail as well.
      console.error('Storage chat is not usable:', err.message);
      this.backup.error = err.message;
      return null;
    }

    if (pinned?.document?.file_name !== BACKUP_FILENAME) {
      console.log('No backup pinned in the storage chat yet, starting fresh.');
      return null;
    }

    this.backup.messageId = pinned.message_id;
    try {
      return JSON.parse(await this.tg.downloadFile(pinned.document.file_id));
    } catch (err) {
      throw new Error(`Could not read the backup: ${err.message}`);
    }
  }
}
