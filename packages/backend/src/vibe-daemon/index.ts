import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  VibeDaemonConfigSchema,
  VibeDaemonEventSchema,
  type VibeDaemonConfig,
  type VibeDaemonEvent,
  type VibeDaemonState,
  type VibeDaemonGameId,
  type VibeDaemonTrigger,
} from '@streamdaemon/shared';
import { getIO } from '../socket/index.js';
import { logger } from '../logger.js';
import { evaluateTrigger, buildActivation, normalizeGameId } from './engine.js';
import { getState, resetState } from './state.js';
import { createGlobalAdapter } from './adapters/global.js';
import { createFortniteAdapter } from './adapters/fortnite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'vibe-daemon.json');

export interface VibeDaemonAdapter {
  name: string;
  handleEvent(event: VibeDaemonEvent): Promise<VibeDaemonState>;
  reset(channel: string, gameId: VibeDaemonGameId): Promise<VibeDaemonState>;
}

const DEFAULT_CONFIG: VibeDaemonConfig = {
  enabled: true,
  triggers: [
    {
      id: 'global-kill',
      gameId: 'fortnite',
      name: '¡ELIMINACIÓN!',
      enabled: true,
      eventType: 'kill',
      condition: { type: 'count', count: 1, period: 'session' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 3000, message: '¡ELIMINACIÓN! ({{kills}} KILLS)' },
    },
    {
      id: 'global-victory',
      gameId: 'fortnite',
      name: '¡VICTORIA MAGISTRAL!',
      enabled: true,
      eventType: 'victory',
      condition: { type: 'count', count: 1, period: 'session' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 5000, message: '👑 ¡VICTORIA MAGISTRAL!' },
    },
    {
      id: 'global-kill-streak',
      gameId: 'fortnite',
      name: '¡RACHA IMPARABLE (5+)!',
      enabled: true,
      eventType: 'kill_streak',
      condition: { type: 'count', count: 5, period: 'match' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 4000, message: '⚡ ¡RACHA DE {{killStreak}} ELIMINACIONES!' },
    },
    {
      id: 'global-victory-streak',
      gameId: 'fortnite',
      name: '¡DOBLE CORONA SEGUIDA!',
      enabled: true,
      eventType: 'victory_streak',
      condition: { type: 'count', count: 2, period: 'session' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 4500, message: '🏆 ¡{{victoryStreak}} VICTORIAS SEGUIDAS!' },
    },
    {
      id: 'fortnite-low-shield',
      gameId: 'fortnite',
      name: '¡ESCUDO ROTO!',
      enabled: true,
      eventType: 'low_shield',
      condition: { type: 'state' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 3000, message: '🛡️ ¡SIN ESCUDO! ¡TOMA MINIS!' },
      cooldownMs: 12000,
    },
    {
      id: 'fortnite-low-health',
      gameId: 'fortnite',
      name: '¡VIDA CRÍTICA!',
      enabled: true,
      eventType: 'low_health',
      condition: { type: 'state' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 3500, message: '🩸 ¡VIDA CRÍTICA! ¡BOTIQUÍN YA!' },
      cooldownMs: 15000,
    },
    {
      id: 'fortnite-storm',
      gameId: 'fortnite',
      name: '¡TORMENTA EN CAMINO!',
      enabled: true,
      eventType: 'storm_shrinking',
      condition: { type: 'state' },
      action: { type: 'overlay', overlayId: 'vibe-daemon', durationMs: 3500, message: '🌀 ¡A LA ZONA! LA TORMENTA SE CIERRA' },
      cooldownMs: 25000,
    },
  ],
  hotkeys: {
    kill: 'CommandOrControl+Shift+K',
    death: 'CommandOrControl+Shift+D',
    victory: 'CommandOrControl+Shift+V',
  },
};

let config: VibeDaemonConfig = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        hotkeys: { ...DEFAULT_CONFIG.hotkeys, ...(parsed.hotkeys || {}) },
      };
    }
  } catch (e) {
    logger.warn({ err: e }, 'Failed to load vibe-daemon.json');
  }
}

function saveConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    logger.warn({ err: e }, 'Failed to save vibe-daemon.json');
  }
}

loadConfig();

function getAdapter(gameId: VibeDaemonGameId): VibeDaemonAdapter {
  switch (normalizeGameId(gameId)) {
    case 'fortnite':
      return createFortniteAdapter({ channel: '' });
    case 'global':
    default:
      return createGlobalAdapter({ channel: '', gameId: 'global' });
  }
}

function emitActivation(trigger: VibeDaemonTrigger, channel: string, event: VibeDaemonEvent, state: VibeDaemonState) {
  const ch = channel.toLowerCase();
  const activation = buildActivation(trigger, ch, event, state);
  const io = getIO();

  io.to(`channel:${ch}`).to('channel:global').emit('vibe-daemon:activation', activation);

  if (trigger.action.type === 'tts') {
    const text = activation.action.message || trigger.name;
    io.to(`channel:${ch}`).to('channel:global').emit('tts:speak', {
      text,
      user: 'Vibe Daemon',
      platform: 'twitch',
      timestamp: Date.now(),
    });
  }

  logger.info(
    { triggerId: trigger.id, eventType: event.eventType, channel: ch, actionType: trigger.action.type },
    'Vibe Daemon triggered',
  );
}

export async function processVibeDaemonEvent(
  event: VibeDaemonEvent,
  options?: { forceTest?: boolean; triggerId?: string },
): Promise<VibeDaemonState> {
  const ch = event.channel.toLowerCase();
  const normalizedEvent: VibeDaemonEvent = { ...event, channel: ch };

  if (!config.enabled && !options?.forceTest) {
    return getState(ch, normalizeGameId(event.gameId));
  }

  const adapter = getAdapter(normalizedEvent.gameId);
  const state = await adapter.handleEvent(normalizedEvent);

  if (options?.triggerId) {
    const exactTrigger = config.triggers.find((tr) => tr.id === options.triggerId);
    if (exactTrigger) {
      emitActivation(exactTrigger, ch, normalizedEvent, state);
    }
  } else {
    const normalizedGameId = normalizeGameId(normalizedEvent.gameId);
    const matchedTriggers = config.triggers.filter((trigger) => {
      const trigGame = normalizeGameId(trigger.gameId);
      const matchesGame = trigGame === 'global' || trigGame === normalizedGameId;
      if (!matchesGame) return false;
      if (options?.forceTest && trigger.eventType === normalizedEvent.eventType) return true;
      return evaluateTrigger(trigger, state, normalizedEvent);
    });

    for (const trigger of matchedTriggers) {
      emitActivation(trigger, ch, normalizedEvent, state);
    }
  }

  const globalState = getState(ch, 'global');
  getIO().to(`channel:${ch}`).to('channel:global').emit('vibe-daemon:state', globalState);
  return globalState;
}

export function getVibeDaemonConfig(): VibeDaemonConfig {
  return {
    ...config,
    triggers: config.triggers.map((t) => ({ ...t })),
    hotkeys: { ...config.hotkeys },
  };
}

export function setupVibeDaemon(app: FastifyInstance) {
  app.get('/vibe-daemon/config', () => getVibeDaemonConfig());

  app.put('/vibe-daemon/config', async (req, reply) => {
    const parsed = VibeDaemonConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid config', details: parsed.error.flatten() });
    }
    config = {
      ...DEFAULT_CONFIG,
      ...parsed.data,
      hotkeys: { ...(parsed.data.hotkeys ?? {}) },
    };
    saveConfig();
    reply.send({ ok: true, config: getVibeDaemonConfig() });
  });

  app.get('/vibe-daemon/state/:channel', async (req) => {
    const { channel } = req.params as { channel: string };
    return getState(channel.toLowerCase(), 'global');
  });

  app.post('/vibe-daemon/event', async (req, reply) => {
    const parsed = VibeDaemonEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid event', details: parsed.error.flatten() });
    }
    const event: VibeDaemonEvent = {
      ...parsed.data,
      channel: parsed.data.channel.toLowerCase(),
      timestamp: parsed.data.timestamp ?? Date.now(),
    };
    const state = await processVibeDaemonEvent(event);
    reply.send({ ok: true, state });
  });

  app.post('/vibe-daemon/reset/:channel', async (req, reply) => {
    const { channel } = req.params as { channel: string };
    const { gameId } = (req.body || {}) as { gameId?: string };
    const ch = channel.toLowerCase();
    resetState(ch, 'global');
    resetState(ch, 'fortnite');
    if (gameId && gameId !== 'global' && gameId !== 'fortnite') {
      resetState(ch, gameId);
    }
    const fresh = getState(ch, 'global');
    getIO().to(`channel:${ch}`).to('channel:global').emit('vibe-daemon:state', fresh);
    reply.send({ ok: true, state: fresh });
  });

  app.post('/vibe-daemon/test', async (req, reply) => {
    const { channel, eventType, gameId, triggerId } = (req.body || {}) as {
      channel?: string;
      eventType?: string;
      gameId?: string;
      triggerId?: string;
    };
    if (!channel || !eventType) {
      return reply.status(400).send({ error: 'Missing channel or eventType' });
    }
    const event: VibeDaemonEvent = {
      channel: channel.toLowerCase(),
      gameId: gameId || 'fortnite',
      eventType: eventType as VibeDaemonEvent['eventType'],
      timestamp: Date.now(),
    };
    const state = await processVibeDaemonEvent(event, { forceTest: true, triggerId });
    reply.send({ ok: true, state });
  });
}
