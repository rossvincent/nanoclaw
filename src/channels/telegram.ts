import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECS = 30;

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function chatJid(chatId: number): string {
  return `tg:${chatId}`;
}

function chatIdFromJid(jid: string): number {
  return parseInt(jid.slice(3), 10);
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private token: string;
  private connected = false;
  private polling = false;
  private offset = 0;
  private abortController: AbortController | null = null;
  private botId: number | null = null;

  private opts: ChannelOpts;

  constructor(token: string, opts: ChannelOpts) {
    this.token = token;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Verify token with getMe
    const me = await this.apiCall<{ id: number; first_name: string }>(
      'getMe',
      {},
    );
    this.botId = me.id;
    this.connected = true;
    logger.info(
      { botId: me.id, botName: me.first_name },
      'Connected to Telegram',
    );

    // Start polling in the background
    this.startPolling();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);

    // Telegram has a 4096 character limit per message.
    // Split long messages into chunks.
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
      });
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    this.connected = false;
    this.abortController?.abort();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Telegram doesn't have a "stop typing" action
    try {
      await this.apiCall('sendChatAction', {
        chat_id: chatIdFromJid(jid),
        action: 'typing',
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send typing indicator');
    }
  }

  // Telegram doesn't have a group sync equivalent — metadata
  // is delivered inline with each message via onChatMetadata.

  private startPolling(): void {
    this.polling = true;
    this.poll().catch((err) => {
      logger.error({ err }, 'Telegram polling loop exited with error');
    });
  }

  private async poll(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const updates = await this.apiCall<TelegramUpdate[]>(
          'getUpdates',
          {
            offset: this.offset,
            timeout: POLL_TIMEOUT_SECS,
            allowed_updates: ['message'],
          },
          (POLL_TIMEOUT_SECS + 10) * 1000, // HTTP timeout slightly longer than long-poll
        );

        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message) {
            this.handleMessage(update.message);
          }
        }
      } catch (err: unknown) {
        if (!this.polling) break;
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          (err instanceof DOMException && err.name === 'AbortError');
        if (isAbort) {
          logger.debug('Telegram poll aborted (shutting down)');
          break;
        }
        logger.error({ err }, 'Telegram poll error, retrying in 5s');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private handleMessage(msg: TelegramMessage): void {
    if (!msg.text) return;

    const jid = chatJid(msg.chat.id);
    const isGroup =
      msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const chatName =
      msg.chat.title ||
      [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') ||
      undefined;
    const timestamp = new Date(msg.date * 1000).toISOString();

    // Always emit metadata so NanoClaw can discover chats
    this.opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      : 'Unknown';
    const sender = msg.from ? `tg:${msg.from.id}` : '';

    const fromMe = msg.from?.id === this.botId;
    const isBotMessage = fromMe;

    this.opts.onMessage(jid, {
      id: String(msg.message_id),
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: msg.text,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
    });
  }

  private async apiCall<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: this.abortController?.signal ?? AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Telegram API ${method} failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { ok: boolean; result: T };
    if (!data.ok) {
      throw new Error(`Telegram API ${method} returned ok=false`);
    }
    return data.result;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const secrets = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = secrets.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set, Telegram channel disabled');
    return null;
  }
  return new TelegramChannel(token, opts);
});
