# Forwarder bot

Post or forward messages into one main channel. Every hour, the bot sends the next batch to all your child channels and groups. When there are no new posts left, it sends random old ones instead.

## How it works

- The bot queues every post that appears in the main channel.
- Each run sends the next 10 new posts, oldest first, to every active child channel.
- If the queue is empty, the run sends 10 different random old posts. Every old post is used once before any repeats.
- An album counts as one post and stays together.
- If one channel fails, the others still get the batch. The failed channel is marked on the dashboard, and it misses that batch.
- If every channel fails, the posts stay in the queue for the next run.

You can change the interval, batch sizes and forward/copy mode on the dashboard.

## Setup

Follow [SETUP.md](SETUP.md). It covers getting the bot token and chat IDs, deploying to Render, and testing.

## Managing channels

You can change the channel list in three ways:

- **Dashboard:** add, remove or turn off channels with the buttons.
- **Dashboard JSON box:** edit the whole file, then click **Save file**. **Copy JSON** copies it.
- **`channels.json` in the repo:** edit it, push, and Render redeploys.

```json
{
  "main": "-1001234567890",
  "settings": {
    "intervalMinutes": 60,
    "newPerRun": 10,
    "randomPerRun": 10,
    "mode": "forward",
    "paused": false
  },
  "children": [
    "https://t.me/plain_link_works",
    { "name": "My group", "chat": "@mygroup", "enabled": true },
    { "name": "Private channel", "chat": "-1009876543210", "enabled": false }
  ]
}
```

**Pushing a changed `channels.json` replaces any edits made on the dashboard.** Before you edit the file in the repo, click **Copy JSON** and start from that.

Private channels have no public link, and the Bot API can't resolve invite links (`t.me/+...`). Add the bot to the chat, post something in it, and use **Add as child** under **Chats the bot is in**.

## Where data is stored

Render's free disk is wiped on every restart. The bot keeps the queue, history and dashboard edits in a pinned file in the backup channel, and restores from it on startup. Without `STORAGE_CHAT_ID`, all of that is lost on each restart.

## Limits

- The Bot API can't read channel history, so the bot only knows about posts made while it is an admin of the main channel. Telegram holds webhook updates for up to 24 hours if the service is down.
- The bot isn't told when a post is deleted from the main channel. Deleted posts are skipped when sending, so a run may deliver fewer than 10.
- The old-post library keeps the latest 5000 posts.
- If the main channel has "Restrict saving content" on, Telegram blocks both forwarding and copying.

## Running locally

```bash
cp .env.example .env   # fill in BOT_TOKEN and ADMIN_PASSWORD
npm install
npm run dev            # http://localhost:3000
npm test
```

With no public URL the bot uses long polling. If the same token is also deployed on Render, that replaces the Render webhook until Render restarts, so use a separate test bot.
