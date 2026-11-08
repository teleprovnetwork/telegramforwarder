import { env } from './env.js';
import { ALLOWED_UPDATES, handleUpdate } from './ingest.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { createWeb, webhookSecret } from './web.js';

const TICK_MS = 30_000;

if (!env.botToken) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env, or set it in Render.');
  process.exit(1);
}

const tg = new Telegram(env.botToken, env.apiBase);
const bot = await tg.call('getMe');

const store = new Store({
  tg,
  storageChat: env.storageChat,
  channelsFile: env.channelsFile,
  dataDir: env.dataDir,
});
await store.load();

const scheduler = new Scheduler({ store, tg, gapMs: env.sendGapMs });
const app = createWeb({ store, tg, scheduler, env, bot });

app.listen(env.port, () => console.log(`@${bot.username} dashboard on port ${env.port}`));

if (env.publicUrl) {
  await tg.call('setWebhook', {
    url: `${env.publicUrl}/telegram/webhook`,
    secret_token: webhookSecret(env.botToken),
    allowed_updates: ALLOWED_UPDATES,
  });
  console.log(`Webhook set to ${env.publicUrl}/telegram/webhook`);
} else {
  await tg.call('deleteWebhook');
  console.log('No public URL, using long polling');
  tg.poll(ALLOWED_UPDATES, (update) => handleUpdate(update, store));
}

setInterval(() => scheduler.tick(), TICK_MS);

// Render sends SIGTERM before stopping the service. Saving here means posts
// from the last few seconds aren't lost.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await store.flush();
    process.exit(0);
  });
}
