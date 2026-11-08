export const DEFAULT_SETTINGS = {
  intervalMinutes: 60,
  newPerRun: 10,
  randomPerRun: 10,
  mode: 'forward',
  paused: false,
};

/**
 * Turns anything a person might paste into the form the Bot API accepts:
 * "https://t.me/foo", "t.me/foo", "foo" and "@foo" become "@foo", and
 * numeric ids and private post links become "-100...".
 */
export function normalizeChat(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Channel link is empty');
  if (/^-?\d+$/.test(value)) return value;

  const link = value.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i);
  const target = link ? link[1] : value;

  const privatePost = target.match(/^c\/(\d+)/);
  if (privatePost) return `-100${privatePost[1]}`;

  if (target.startsWith('+') || target.startsWith('joinchat')) {
    throw new Error(
      `Invite links can't be used (${value}). Add the bot to that chat as admin, ` +
        'then pick it from the "Chats the bot is in" list.',
    );
  }

  const username = target.replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!/^[A-Za-z0-9_]{4,}$/.test(username)) throw new Error(`Not a valid channel link: ${value}`);
  return `@${username}`;
}

function intSetting(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

/** Validates a config object and fills in defaults. Throws a readable error. */
export function parseConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }

  const merged = { ...DEFAULT_SETTINGS, ...raw.settings };
  if (!['forward', 'copy'].includes(merged.mode)) throw new Error('mode must be "forward" or "copy"');

  const settings = {
    intervalMinutes: intSetting(merged.intervalMinutes, 'intervalMinutes', 1, 10_080),
    newPerRun: intSetting(merged.newPerRun, 'newPerRun', 1, 100),
    randomPerRun: intSetting(merged.randomPerRun, 'randomPerRun', 0, 100),
    mode: merged.mode,
    paused: Boolean(merged.paused),
  };

  const main = raw.main ? normalizeChat(raw.main) : '';

  if (raw.children !== undefined && !Array.isArray(raw.children)) throw new Error('children must be a list');
  const children = [];
  const seen = new Set();
  for (const entry of raw.children ?? []) {
    const isText = typeof entry === 'string' || typeof entry === 'number';
    const chat = normalizeChat(isText ? entry : entry?.chat);
    const key = chat.toLowerCase();
    if (seen.has(key)) continue;
    if (chat === main) throw new Error(`${chat} is the main channel, so it can't also be a child`);
    seen.add(key);
    children.push({
      name: (!isText && entry.name) || chat,
      chat,
      enabled: isText ? true : entry.enabled !== false,
    });
  }

  return { main, settings, children };
}

/** True when a Telegram chat object is the chat a config value points at. */
export function isSameChat(chat, configured) {
  if (!configured) return false;
  if (configured.startsWith('@')) {
    return chat.username?.toLowerCase() === configured.slice(1).toLowerCase();
  }
  return String(chat.id) === configured;
}
