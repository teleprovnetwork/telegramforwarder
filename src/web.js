import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { isSameChat, normalizeChat, parseConfig } from './channels.js';
import { rootDir } from './env.js';
import { handleUpdate } from './ingest.js';

const DAY_MS = 86_400_000;

const digest = (text) => createHash('sha256').update(text).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

/** Telegram echoes this back on each webhook call, which proves the sender. */
export const webhookSecret = (token) => digest(`webhook:${token}`).toString('hex');

function requireAdmin(env) {
  return (req, res, next) => {
    if (!env.adminPassword) {
      return res.status(503).type('text').send('Set ADMIN_PASSWORD to open the dashboard.');
    }
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const [user, ...rest] = Buffer.from(encoded || '', 'base64').toString().split(':');
    const allowed =
      scheme === 'Basic' && safeEqual(user, env.adminUser) && safeEqual(rest.join(':'), env.adminPassword);
    if (allowed) return next();
    res.set('WWW-Authenticate', 'Basic realm="Forwarder bot"').status(401).send('Login required');
  };
}

/** Browsers resend Basic auth on any request, so block forms from other sites. */
function rejectCrossSite(req, res, next) {
  const origin = req.get('origin');
  if (req.method === 'POST' && origin && origin.replace(/^https?:\/\//, '') !== req.get('host')) {
    return res.status(403).send('Cross-site request blocked');
  }
  next();
}

function buildReport({ store, scheduler, env, bot }) {
  const { state, config, backup } = store;
  const dayAgo = Date.now() - DAY_MS;
  const recentRuns = state.runs.filter((run) => run.at >= dayAgo);
  const enabled = config.children.filter((child) => child.enabled);

  const warnings = [];
  if (!config.main) warnings.push('No main channel set. Pick one below, or add it to channels.json.');
  if (enabled.length === 0) warnings.push('No active child channels, so nothing will be sent.');
  if (!env.storageChat) {
    warnings.push('STORAGE_CHAT_ID is not set. On Render, the queue and history are lost on every restart.');
  }
  if (backup.error) warnings.push(`Backup to Telegram is failing: ${backup.error}`);

  const isListed = (chat) =>
    isSameChat(chat, config.main) || config.children.some((child) => isSameChat(chat, child.chat));

  return {
    bot,
    settings: config.settings,
    main: config.main,
    warnings,
    running: scheduler.running,
    nextRunAt: scheduler.nextRunAt(),
    lastRunAt: state.lastRunAt,
    backupAt: backup.at,
    pending: state.queue.length,
    library: state.library.length,
    delivered24h: recentRuns.reduce((sum, run) => sum + run.delivered, 0),
    runs24h: recentRuns.length,
    channels: config.children.map((child) => ({ ...child, stats: state.channelStats[child.chat] })),
    runs: state.runs.slice(0, 25),
    queue: state.queue.slice(0, 15),
    chats: Object.values(state.chats).filter(
      (chat) => !isListed(chat) && String(chat.id) !== env.storageChat,
    ),
    configJson: JSON.stringify(config, null, 2),
  };
}

export function createWeb({ store, tg, scheduler, env, bot }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.disable('x-powered-by');

  // Uptime pings keep the service awake and double as a scheduler heartbeat.
  app.get(['/ping', '/health'], (req, res) => {
    scheduler.tick();
    res.type('text').send('ok');
  });

  app.head(['/ping', '/health'], (req, res) => {
    scheduler.tick();
    res.status(200).end();
  });

  app.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
    const secret = req.get('x-telegram-bot-api-secret-token') || '';
    if (!safeEqual(secret, webhookSecret(env.botToken))) return res.sendStatus(401);
    handleUpdate(req.body, store);
    res.sendStatus(200);
  });

  app.use(express.static(path.join(rootDir, 'public')));
  app.use(requireAdmin(env), rejectCrossSite, express.urlencoded({ extended: false, limit: '256kb' }));

  const flash = (res, kind, message) => res.redirect(`/?${kind}=${encodeURIComponent(message)}`);

  /** Applies a change to a copy of the config, so a bad edit leaves it intact. */
  const changeConfig = (res, change, message) => {
    try {
      const next = structuredClone(store.config);
      change(next);
      store.setConfig(parseConfig(next));
      flash(res, 'ok', message);
    } catch (err) {
      flash(res, 'err', err.message);
    }
  };

  app.get('/', (req, res) => {
    res.render('dashboard', {
      ...buildReport({ store, scheduler, env, bot }),
      ok: req.query.ok,
      err: req.query.err,
    });
  });

  app.post('/channels/add', async (req, res) => {
    const added = [];
    const problems = [];

    for (const line of String(req.body.links || '').split(/[\r\n,]+/)) {
      if (!line.trim()) continue;
      try {
        const chat = normalizeChat(line);
        let name = req.body.name || chat;
        try {
          name = (await tg.call('getChat', { chat_id: chat })).title || name;
        } catch (err) {
          problems.push(`${chat} was added, but the bot can't reach it yet: ${err.message}`);
        }
        added.push({ name, chat, enabled: true });
      } catch (err) {
        problems.push(err.message);
      }
    }

    if (problems.length > 0 && added.length === 0) return flash(res, 'err', problems.join(' | '));
    const summary = [`Added ${added.length} channel(s)`, ...problems].join(' | ');
    changeConfig(res, (config) => config.children.push(...added), summary);
  });

  app.post('/channels/remove', (req, res) => {
    changeConfig(
      res,
      (config) => {
        config.children = config.children.filter((child) => child.chat !== req.body.chat);
      },
      `Removed ${req.body.chat}`,
    );
  });

  app.post('/channels/toggle', (req, res) => {
    changeConfig(
      res,
      (config) => {
        const child = config.children.find((entry) => entry.chat === req.body.chat);
        if (child) child.enabled = !child.enabled;
      },
      `Updated ${req.body.chat}`,
    );
  });

  app.post('/channels/main', (req, res) => {
    changeConfig(
      res,
      (config) => {
        config.main = req.body.chat;
      },
      'Main channel updated',
    );
  });

  app.post('/settings', (req, res) => {
    const { intervalMinutes, newPerRun, randomPerRun, mode } = req.body;
    changeConfig(
      res,
      (config) => Object.assign(config.settings, { intervalMinutes, newPerRun, randomPerRun, mode }),
      'Settings saved',
    );
  });

  app.post('/pause', (req, res) => {
    const paused = !store.config.settings.paused;
    changeConfig(
      res,
      (config) => {
        config.settings.paused = paused;
      },
      paused ? 'Paused' : 'Resumed',
    );
  });

  app.post('/config', (req, res) => {
    try {
      store.setConfig(parseConfig(JSON.parse(req.body.json)));
      flash(res, 'ok', 'channels.json saved');
    } catch (err) {
      flash(res, 'err', `Not saved: ${err.message}`);
    }
  });

  app.post('/run', (req, res) => {
    scheduler.run({ manual: true }).catch((err) => console.error('Manual run failed:', err));
    flash(res, 'ok', 'Run started. Refresh in a moment to see the result.');
  });

  return app;
}
