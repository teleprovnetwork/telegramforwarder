# Setup guide

Follow these steps in order. It takes about 30 minutes.

## What you need

| Value | What it is | Where it goes | How you get it |
| --- | --- | --- | --- |
| `BOT_TOKEN` | The bot's password | Render | Step 1 |
| `ADMIN_PASSWORD` | Your dashboard password | Render | You make it up |
| `STORAGE_CHAT_ID` | ID of the private backup channel | Render | Step 4 |

This is the only ID you copy by hand. You connect your main and child channels with buttons on the dashboard in step 8.

You also need free accounts on [GitHub](https://github.com), [Render](https://render.com) and an uptime service such as [UptimeRobot](https://uptimerobot.com).

**Keep `BOT_TOKEN` secret.** Anyone who has it controls your bot. Don't put it in `channels.json`, don't commit it to GitHub, and don't post it in a chat.

---

## Part 1: Telegram

### Step 1: Create the bot and get `BOT_TOKEN`

1. In Telegram, open [@BotFather](https://t.me/BotFather). Check that it has the blue tick.
2. Send `/newbot`.
3. Send a display name, such as `My Forwarder`.
4. Send a username ending in `bot`, such as `my_forwarder_bot`.
5. BotFather replies with a token that looks like this:

   ```
   1234567890:AAExampleTokenTextGoesHere_abc123
   ```

6. Save the token somewhere private.

### Step 2: Create the backup channel

The bot stores its queue and history in this channel, because Render wipes its disk on every restart.

1. In Telegram, create a new channel. Name it something like `Forwarder Backup`.
2. Make it **Private**.
3. Use it only for the bot. Don't post or pin anything in it after setup.

### Step 3: Add the bot as admin everywhere

Do this in the **main channel**, the **backup channel**, and **every child channel or group**:

1. Open the channel or group, then open its info page.
2. Go to **Edit** (or **Manage**) > **Administrators** > **Add Admin**.
3. Search for your bot's username and select it.
4. Turn on the permissions below, then save.

| Where | Permissions the bot needs |
| --- | --- |
| Main channel | Post Messages |
| Child channels | Post Messages |
| Child groups | Admin, with permission to send messages |
| Backup channel | Post Messages, Edit Messages of Others, Delete Messages of Others |

The bot must be an admin of the main channel, or Telegram won't tell it about new posts.

In the main channel, also check that **Restrict Saving Content** is off, under **Edit** > **Channel Type**. If it's on, Telegram won't let the bot send your posts.

### Step 4: Get the backup channel's ID

1. Post any short message, such as `hi`, in the backup channel.
2. Open this address in your browser, with your token in place of `YOUR_TOKEN`. Keep the word `bot` directly before the token:

   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```

3. Search the page (Ctrl+F) for the backup channel's title. You'll see something like this:

   ```json
   "chat":{"id":-1001234567890,"title":"Forwarder Backup","type":"channel"}
   ```

4. Copy the `id`, including the minus sign.

If the page shows `"result":[]`, post one more message in the channel and refresh.

---

## Part 2: Prepare the code

### Step 5: Push to GitHub

Leave `channels.json` as it is, with `main` empty. If you set `main` now, any test message you already posted there could be sent to all your channels when the bot starts.

1. On GitHub, create a new **private** repository. Leave it empty, with no README.
2. In a terminal in this project folder, run these commands, using your own repo URL:

   ```bash
   git init
   git add .
   git commit -m "Forwarder bot"
   git branch -M main
   git remote add origin https://github.com/YOUR_NAME/forwarder-bot.git
   git push -u origin main
   ```

---

## Part 3: Deploy

### Step 6: Create the service on Render

1. Log in to [Render](https://dashboard.render.com) and connect your GitHub account.
2. Click **New** > **Blueprint**, then select your repository.
3. Render reads `render.yaml` and asks for three values. **It only asks once**, so fill them all in now:

   | Name | Value |
   | --- | --- |
   | `BOT_TOKEN` | The token from step 1 |
   | `ADMIN_PASSWORD` | A strong password you make up |
   | `STORAGE_CHAT_ID` | The backup channel's ID from step 4, such as `-1001234567890` |

4. Click **Deploy Blueprint** and wait for the deploy to finish.
5. Open the service page and copy its URL, such as `https://forwarder-bot-abcd.onrender.com`.

To change one of these values later, open the service on Render and go to **Environment**.

### Step 7: Open the dashboard

1. Open your Render URL.
2. Log in with the username `admin` and your `ADMIN_PASSWORD`.

Two yellow warnings are normal at this point: no main channel, and no active child channels. Step 8 clears both. A warning about `STORAGE_CHAT_ID` or the backup is not normal, so fix that first (see Troubleshooting).

### Step 8: Connect your channels

1. Post `hi` in the main channel and in each child channel or group.
2. Refresh the dashboard. They appear under **Chats the bot is in**.
3. Click **Set as main** next to your main channel. Do this after posting `hi`, so that message isn't sent out.
4. Click **Add as child** next to each of the others.
5. Check that the top of the page shows your main channel's ID, your child channels are listed, and there are no yellow warnings.
6. Delete the `hi` messages from your channels.
7. At the bottom of the dashboard, click **Copy JSON** and save it somewhere safe. It's your copy of the channel list.

### Step 9: Set up the uptime monitor

1. In UptimeRobot, click **New monitor** and choose **HTTP(s)**.
2. Use your Render URL with `/ping` on the end:

   ```
   https://forwarder-bot-abcd.onrender.com/ping
   ```

3. Set the interval to **5 minutes**. Don't use 15: Render sleeps after 15 minutes without traffic, so the ping can arrive too late.

---

## Part 4: Test it

### Step 10: Check that sending works

Use the same kind of posts you'll send every day: images with a caption, plus one album if you use them.

1. Forward 3 posts into the main channel.
2. Wait 15 seconds and refresh the dashboard. **New posts waiting** should show 3. An album counts as 1.
3. Click **Send now**, wait a few seconds per channel, then refresh.
4. Check that the posts arrived in your child channels, with the image, the caption and any bold text or links intact. **Recent runs** shows the result for each channel.

If you plan to use **Copy** mode, change **Send as** in Settings and repeat this with 3 more posts. The posts should arrive with no "Forwarded from" line.

### Step 11: Check that the backup works

1. Note the **Old posts for random runs** number. It should be 3.
2. Open the backup channel. You should see a pinned file called `forwarder-state.json`.
3. On Render, click **Manual Deploy** > **Deploy latest commit**. This wipes the disk.
4. When the deploy finishes, refresh the dashboard. The number should still be 3.

If the number is still there, setup is complete. Forward your daily posts to the main channel and the bot does the rest.

---

## Adding a channel later

1. Add the bot as admin in the new channel (step 3).
2. Post something in the channel.
3. Refresh the dashboard. The channel appears under **Chats the bot is in**.
4. Click **Add as child**.
5. Delete the message you posted.

## Troubleshooting

| What you see | What it means | Fix |
| --- | --- | --- |
| Render logs say `BOT_TOKEN is missing` | The value wasn't saved | Add it under **Environment** on Render |
| `getUpdates` shows `Not Found` (error 404) | The address is wrong, usually because `bot` is missing before the token | Use `https://api.telegram.org/bot` + your token + `/getUpdates`, with no spaces |
| `getUpdates` shows `Unauthorized` | The token is wrong | Copy it again, and keep `bot` directly before it |
| `getUpdates` shows `Conflict` | The bot is already deployed, so this page no longer works | Use **Chats the bot is in** on the dashboard |
| A channel isn't under **Chats the bot is in** | The bot hasn't seen it yet | Check that the bot is an admin there, post a message, and refresh |
| `Forbidden: bot is not a member of the channel chat` | The bot isn't in that channel | Add it as admin (step 3) |
| `Bad Request: chat not found` | The ID or link is wrong, or the bot isn't in the chat | Check the ID, including the minus sign, and step 3 |
| `need administrator rights` or `not enough rights` | The bot's permissions are too low | Turn on Post Messages (step 3) |
| `Backup to Telegram is failing` | The bot can't use the backup channel | Check `STORAGE_CHAT_ID` and the permissions in step 3 |
| A group that worked now fails with `group chat was upgraded to a supergroup` | Telegram changed the group's ID | Remove it, post in the group, then use **Add as child** |
| **New posts waiting** stays at 0 | The bot isn't seeing the main channel | Check that it is an admin there and that `main` is the right ID |
| The site takes about a minute to open | Render was asleep | Check that the uptime monitor is running |
