import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // No .env file: on Render the values come from the real environment.
}

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const env = {
  botToken: process.env.BOT_TOKEN || '',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  storageChat: process.env.STORAGE_CHAT_ID || '',
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  port: Number(process.env.PORT) || 3000,
  apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  channelsFile: process.env.CHANNELS_FILE || path.join(rootDir, 'channels.json'),
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  sendGapMs: Number(process.env.SEND_GAP_MS ?? 1000),
};
