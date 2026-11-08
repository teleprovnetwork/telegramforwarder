const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RATE_LIMIT_WAIT_S = 60;

export class TelegramError extends Error {
  constructor(method, status, body) {
    super(body?.description || `Telegram returned HTTP ${status}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = body?.error_code ?? status;
    this.retryAfter = body?.parameters?.retry_after;
  }
}

/** Thin Bot API client. Files are passed as { field: [Blob, filename] }. */
export class Telegram {
  constructor(token, apiBase = 'https://api.telegram.org') {
    this.token = token;
    this.apiBase = apiBase;
  }

  async call(method, params = {}, { files, timeoutMs = 60_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#request(method, params, files, timeoutMs);
      } catch (err) {
        const rateLimited = err.code === 429 && err.retryAfter <= MAX_RATE_LIMIT_WAIT_S;
        if (rateLimited && attempt < 3) {
          await sleep((err.retryAfter + 1) * 1000);
          continue;
        }
        // Only reads are retried on a dropped connection: a send may already
        // have gone through, and repeating it would post duplicates.
        const transient = !(err instanceof TelegramError) || err.code >= 500;
        if (transient && method.startsWith('get') && attempt < 2) {
          await sleep(2000);
          continue;
        }
        throw err;
      }
    }
  }

  async #request(method, params, files, timeoutMs) {
    const init = { method: 'POST', signal: AbortSignal.timeout(timeoutMs) };

    if (files) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) form.append(key, String(value));
      for (const [key, [blob, filename]] of Object.entries(files)) form.append(key, blob, filename);
      init.body = form;
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(params);
    }

    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, init);
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw new TelegramError(method, res.status, body);
    return body.result;
  }

  async downloadFile(fileId) {
    const { file_path: filePath } = await this.call('getFile', { file_id: fileId });
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new TelegramError('downloadFile', res.status);
    return res.text();
  }

  /** Long polling, used when the bot has no public URL for a webhook. */
  async poll(allowedUpdates, onUpdate) {
    let offset;
    for (;;) {
      try {
        const updates = await this.call(
          'getUpdates',
          { offset, timeout: 30, allowed_updates: allowedUpdates },
          { timeoutMs: 40_000 },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          onUpdate(update);
        }
      } catch (err) {
        console.error('Polling failed:', err.message);
        await sleep(5000);
      }
    }
  }
}
