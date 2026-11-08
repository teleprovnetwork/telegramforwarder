import { isSameChat } from './channels.js';

export const ALLOWED_UPDATES = ['channel_post', 'message', 'my_chat_member'];

// Allow-list, because service messages ("X pinned a post", title changes)
// can't be forwarded.
const CONTENT_KINDS = [
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'video_note',
  'sticker',
  'poll',
  'location',
  'venue',
  'contact',
  'dice',
  'paid_media',
  'text',
];

const PREVIEW_LENGTH = 80;

function rememberChat(store, chat, status) {
  if (chat.type === 'private') return;
  const known = store.state.chats[chat.id];
  const next = {
    id: String(chat.id),
    title: chat.title || chat.username || String(chat.id),
    username: chat.username || '',
    type: chat.type,
    status: status ?? known?.status ?? 'member',
  };
  if (JSON.stringify(known) === JSON.stringify(next)) return;
  store.state.chats[chat.id] = next;
  store.save();
}

function addPost(store, message) {
  const kind = CONTENT_KINDS.find((key) => message[key] !== undefined);
  if (!kind) return;

  const { queue, library } = store.state;
  const alreadyStored = (item) => item.ids.includes(message.message_id) && item.from === String(message.chat.id);
  if (queue.some(alreadyStored) || library.some(alreadyStored)) return; // Telegram can redeliver updates

  // An album arrives as one update per photo. It stays one item so it counts
  // once toward the batch size and is forwarded as an album.
  const album = message.media_group_id && queue.find((item) => item.album === message.media_group_id);
  // Spread first so the cut can't land in the middle of an emoji.
  const text = [...(message.text || message.caption || '')].slice(0, PREVIEW_LENGTH).join('');

  if (album) {
    album.ids.push(message.message_id);
    album.ids.sort((a, b) => a - b);
    album.preview ||= text; // the caption can be on any photo of the album
    album.addedAt = Date.now(); // wait again, in case more photos are on the way
  } else {
    queue.push({
      ids: [message.message_id],
      from: String(message.chat.id),
      album: message.media_group_id || null,
      kind,
      preview: text,
      addedAt: Date.now(),
      sends: 0,
      lastSentAt: 0,
    });
  }
  store.save();
}

export function handleUpdate(update, store) {
  if (update.my_chat_member) {
    const { chat, new_chat_member: member } = update.my_chat_member;
    rememberChat(store, chat, member.status);
    return;
  }

  const message = update.channel_post || update.message;
  if (!message) return;

  rememberChat(store, message.chat);
  if (isSameChat(message.chat, store.config.main)) addPost(store, message);
}
