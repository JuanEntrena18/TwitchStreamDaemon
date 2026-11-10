import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';

export interface StoredEvent {
  id: string;
  type: string;
  user: string;
  message: string;
  timestamp: number;
  amount?: number;
  platform?: 'twitch' | 'youtube';
  formattedAmount?: string;
  channel?: string;
}

const MAX_EVENTS = 150;
const DATA_DIR = path.join(process.cwd(), 'data');
const ACTIVITY_FILE = path.join(DATA_DIR, 'recent-activity.json');

const events = new Map<string, StoredEvent[]>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadStoredActivity() {
  try {
    if (!fs.existsSync(ACTIVITY_FILE)) return;
    const raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, StoredEvent[]>;
    if (parsed && typeof parsed === 'object') {
      for (const [ch, list] of Object.entries(parsed)) {
        if (Array.isArray(list)) {
          events.set(ch.toLowerCase(), list.slice(0, MAX_EVENTS));
        }
      }
    }
  } catch {
    // Ignore corrupt activity cache
  }
}

function scheduleSaveActivity() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const serializable: Record<string, StoredEvent[]> = {};
      for (const [ch, list] of events.entries()) {
        serializable[ch] = list.slice(0, MAX_EVENTS);
      }
      fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(serializable, null, 2), 'utf-8');
    } catch {
      // Ignore write failures
    }
  }, 1200);
}

loadStoredActivity();

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function recordEvent(
  channel: string,
  type: string,
  user: string,
  message: string,
  amount?: number,
  platform: 'twitch' | 'youtube' = 'twitch',
  formattedAmount?: string,
) {
  const key = (channel || 'global').toLowerCase();
  if (!events.has(key)) {
    events.set(key, []);
  }
  const list = events.get(key)!;
  const entry: StoredEvent = {
    id: generateId(),
    type,
    user,
    message,
    timestamp: Date.now(),
    amount,
    platform,
    formattedAmount,
    channel: key,
  };
  list.unshift(entry);
  if (list.length > MAX_EVENTS) {
    list.length = MAX_EVENTS;
  }
  scheduleSaveActivity();
  return entry;
}

export function getEvents(channel?: string, extraChannels: string[] = []): StoredEvent[] {
  const keys = new Set<string>(['global']);
  if (channel) keys.add(channel.toLowerCase());
  for (const extra of extraChannels) {
    if (extra) keys.add(extra.toLowerCase());
  }
  // In a single-streamer local-first app, include all recorded channel buckets so
  // switching between Twitch login and YouTube handle never hides recent events.
  for (const existingKey of events.keys()) {
    keys.add(existingKey);
  }

  const merged = new Map<string, StoredEvent>();
  for (const k of keys) {
    const list = events.get(k);
    if (!list) continue;
    for (const item of list) {
      if (!merged.has(item.id)) {
        merged.set(item.id, {
          ...item,
          platform: item.platform || 'twitch',
        });
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_EVENTS);
}

export function clearEvents() {
  events.clear();
  scheduleSaveActivity();
}

export function setupActivity(app: FastifyInstance) {
  app.get('/activity', async () => {
    return getEvents();
  });

  app.get('/activity/:channel', async (req) => {
    const { channel } = req.params as { channel: string };
    return getEvents(channel.toLowerCase());
  });

  app.delete('/activity', async () => {
    clearEvents();
    return { ok: true };
  });
}
