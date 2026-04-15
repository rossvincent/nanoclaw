import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN: 'test-token-123' })),
}));

import { TelegramChannel } from './telegram.js';
import type { ChannelOpts } from './registry.js';

function createTestOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

const getMeResponse = () =>
  ({
    ok: true,
    json: async () => ({
      ok: true,
      result: { id: 999, first_name: 'Bot' },
    }),
    text: async () => '',
  }) as Response;

function updatesResponse(updates: unknown[]): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, result: updates }),
    text: async () => '',
  } as Response;
}

describe('TelegramChannel', () => {
  let channel: TelegramChannel;
  let opts: ChannelOpts;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    opts = createTestOpts();
    channel = new TelegramChannel('test-token-123', opts);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.restoreAllMocks();
  });

  describe('ownsJid', () => {
    it('owns tg: prefixed JIDs', () => {
      expect(channel.ownsJid('tg:12345')).toBe(true);
      expect(channel.ownsJid('tg:-100123456')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      expect(channel.ownsJid('123@s.whatsapp.net')).toBe(false);
      expect(channel.ownsJid('123@g.us')).toBe(false);
    });

    it('does not own unknown JIDs', () => {
      expect(channel.ownsJid('random:123')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('starts disconnected', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('calls sendMessage API with correct chat_id', async () => {
      const sendResponse = {
        ok: true,
        json: async () => ({ ok: true, result: true }),
        text: async () => '',
      } as Response;

      fetchSpy
        .mockResolvedValueOnce(getMeResponse()) // getMe
        .mockReturnValueOnce(new Promise(() => {})) // first poll hangs
        .mockResolvedValueOnce(sendResponse); // sendMessage

      await channel.connect();
      await channel.sendMessage('tg:12345', 'Hello!');

      const sendCall = fetchSpy.mock.calls.find((c: [string, ...unknown[]]) =>
        (c[0] as string).includes('/sendMessage'),
      );
      expect(sendCall).toBeDefined();
      const body = JSON.parse((sendCall![1] as RequestInit).body as string);
      expect(body.chat_id).toBe(12345);
      expect(body.text).toBe('Hello!');
    });
  });

  describe('message handling', () => {
    it('emits onChatMetadata for all messages', async () => {
      const updates = [
        {
          update_id: 1,
          message: {
            message_id: 100,
            from: { id: 555, first_name: 'Ross' },
            chat: { id: 12345, type: 'private', first_name: 'Ross' },
            date: 1700000000,
            text: 'Hello bot',
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(getMeResponse()) // getMe
        .mockResolvedValueOnce(updatesResponse(updates)) // first poll with data
        .mockReturnValue(new Promise(() => {})); // subsequent polls hang

      await channel.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Ross',
        'telegram',
        false,
      );
    });

    it('delivers messages for registered groups only', async () => {
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'tg:12345': {
          name: 'ross',
          folder: 'ross',
          trigger: '@Andy',
          added_at: '',
        },
      });

      const updates = [
        {
          update_id: 1,
          message: {
            message_id: 100,
            from: { id: 555, first_name: 'Ross' },
            chat: { id: 12345, type: 'private', first_name: 'Ross' },
            date: 1700000000,
            text: 'Hello',
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 101,
            from: { id: 666, first_name: 'Stranger' },
            chat: { id: 99999, type: 'private', first_name: 'Stranger' },
            date: 1700000001,
            text: 'Spam',
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(getMeResponse())
        .mockResolvedValueOnce(updatesResponse(updates))
        .mockReturnValue(new Promise(() => {}));

      await channel.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: 'Hello',
          sender_name: 'Ross',
        }),
      );
    });

    it('identifies group chats correctly', async () => {
      const updates = [
        {
          update_id: 1,
          message: {
            message_id: 100,
            from: { id: 555, first_name: 'Ross' },
            chat: { id: -100123, type: 'supergroup', title: 'Team Chat' },
            date: 1700000000,
            text: 'Hello',
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(getMeResponse())
        .mockResolvedValueOnce(updatesResponse(updates))
        .mockReturnValue(new Promise(() => {}));

      await channel.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:-100123',
        expect.any(String),
        'Team Chat',
        'telegram',
        true,
      );
    });
  });
});
