import { FastifyInstance } from 'fastify';
import { ApiClient } from '@twurple/api';
import { authProvider, currentUser } from '../auth/index.js';
import { currentYouTubeUser, fetchYouTubeHud } from '../youtube/index.js';
import { emitToStreamRooms } from '../socket/index.js';
import type { HudData } from '@streamdaemon/shared';
import { recordSnapshot } from '../kpi/index.js';
import { logger } from '../logger.js';

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchHud(channelName: string): Promise<HudData | null> {
  const ytHud = currentYouTubeUser ? await fetchYouTubeHud().catch(() => null) : null;

  try {
    if (!authProvider || !currentUser) {
      return ytHud;
    }
    const api = new ApiClient({ authProvider });
    const cleanName = String(channelName || '').trim().replace(/^[@#]/, '').toLowerCase();
    const user =
      (cleanName && /^[a-z0-9_]{2,25}$/.test(cleanName)
        ? await api.users.getUserByName(cleanName).catch(() => null)
        : null) ??
      (currentUser?.login ? await api.users.getUserByName(currentUser.login).catch(() => null) : null);
    if (!user) return ytHud;

    const [stream, channelInfo] = await Promise.all([
      api.streams.getStreamByUserId(user.id).catch(() => null),
      api.channels.getChannelInfoById(user.id).catch(() => null),
    ]);

    let totalFollowers = 0;
    let lastFollower: string | null = null;
    try {
      const followInfo = await api.channels.getChannelFollowers(user.id, user.id);
      totalFollowers = followInfo.total;
      if (followInfo.data.length > 0) {
        lastFollower = followInfo.data[0].userDisplayName;
      }
    } catch (e) {
      logger.warn({ channel: channelName, err: e }, '[HUD] Followers fetch failed');
    }

    let totalSubs = 0;
    let lastSubscriber: string | null = null;
    try {
      const subs = await api.subscriptions.getSubscriptions(user.id);
      totalSubs = subs.total;
      if (subs.data.length > 0) {
        lastSubscriber = subs.data[0].userDisplayName;
      }
    } catch (e) {
      logger.warn({ channel: channelName, err: e }, '[HUD] Subs fetch failed');
    }

    const twUptimeSeconds = stream?.startDate
      ? Math.floor((Date.now() - stream.startDate.getTime()) / 1000)
      : 0;
    const twTitle = stream?.title || channelInfo?.title || user.displayName;
    const twGameName = stream?.gameName || channelInfo?.gameName || '';
    const twStartedAt = stream?.startDate?.toISOString() ?? null;

    const twitchBreakdown = {
      viewers: stream?.viewers ?? 0,
      followers: totalFollowers,
      subscribers: totalSubs,
      uptimeSeconds: twUptimeSeconds,
      streamTitle: twTitle,
      gameName: twGameName,
      startedAt: twStartedAt,
      login: user.name,
      displayName: user.displayName,
      isLive: !!stream,
    };

    const twitchHud: HudData = {
      platform: 'twitch',
      platformBreakdown: {
        twitch: twitchBreakdown,
      },
      viewers: twitchBreakdown.viewers,
      followers: totalFollowers,
      subscribers: totalSubs,
      uptimeSeconds: twUptimeSeconds,
      streamTitle: twTitle,
      gameName: twGameName,
      startedAt: twStartedAt,
      isLive: !!stream,
      lastFollower,
      lastSubscriber,
    };

    if (!ytHud) return twitchHud;

    return {
      platform: 'multi',
      viewers: twitchHud.viewers + ytHud.viewers,
      followers: twitchHud.followers + ytHud.followers,
      subscribers: twitchHud.subscribers + ytHud.subscribers,
      uptimeSeconds: Math.max(twitchHud.uptimeSeconds, ytHud.uptimeSeconds),
      streamTitle: twitchHud.isLive ? twitchHud.streamTitle : (ytHud.isLive ? ytHud.streamTitle : twitchHud.streamTitle),
      gameName: twitchHud.gameName || ytHud.gameName,
      startedAt: twitchHud.startedAt ?? ytHud.startedAt,
      isLive: twitchHud.isLive || ytHud.isLive,
      lastFollower: twitchHud.lastFollower ?? ytHud.lastFollower,
      lastSubscriber: twitchHud.lastSubscriber ?? ytHud.lastSubscriber,
      platformBreakdown: {
        twitch: twitchBreakdown,
        youtube: ytHud.platformBreakdown?.youtube,
      },
    };
  } catch (e) {
    logger.warn({ channel: channelName, err: e }, '[HUD] fetchHud failed');
    return ytHud;
  }
}

export function setupHud(app: FastifyInstance) {
  app.get('/hud/:channel', async (req, reply) => {
    const { channel } = req.params as { channel: string };
    if (!channel) return reply.status(400).send({ error: 'Missing channel' });
    const data = await fetchHud(channel);
    if (!data) return reply.status(503).send({ error: 'HUD not available' });
    return data;
  });

  app.post('/hud/start-poll', async (req, reply) => {
    const { channel, interval = 10 } = req.body as { channel: string; interval?: number };
    if (!channel) return reply.status(400).send({ error: 'Missing channel' });
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      const data = await fetchHud(channel);
      if (data) {
        emitToStreamRooms('hud:update', data, channel);
        // Fetch active chatters count for KPI audience graph
        let chattersCount = 0;
        try {
          if (authProvider && data.isLive) {
            const api = new ApiClient({ authProvider });
            const user = await api.users.getUserByName(channel);
            if (user) {
              const chattersResult = await api.chat.getChatters(user.id);
              chattersCount = chattersResult.data.length;
            }
          }
        } catch { /* ignore chatters fetch errors */ }
        recordSnapshot(
          channel.toLowerCase(),
          data.viewers,
          chattersCount,
          data.platformBreakdown?.twitch?.viewers ?? 0,
          data.platformBreakdown?.youtube?.viewers ?? 0,
        );
      }
    }, interval * 1000);
    reply.send({ ok: true, interval });
  });

  app.post('/hud/stop-poll', async (_req, reply) => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    reply.send({ ok: true });
  });

  // Update stream title / game / tags
  app.put('/hud/stream/info', async (req, reply) => {
    const { channel, title, gameName, tags } = req.body as { channel: string; title?: string; gameName?: string; tags?: string[] };
    if (!channel && !currentUser?.login) return reply.status(400).send({ error: 'Missing channel' });

    try {
      if (!authProvider) return reply.status(503).send({ error: 'Not authenticated' });
      const api = new ApiClient({ authProvider });
      const cleanName = String(channel || '').trim().replace(/^[@#]/, '').toLowerCase();
      const user =
        (cleanName && /^[a-z0-9_]{2,25}$/.test(cleanName)
          ? await api.users.getUserByName(cleanName).catch(() => null)
          : null) ??
        (currentUser?.login ? await api.users.getUserByName(currentUser.login).catch(() => null) : null);
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const update: { title?: string; gameId?: string; tags?: string[] } = {};
      if (title !== undefined) update.title = title;
      if (gameName !== undefined && gameName) {
        const result = await api.search.searchCategories(gameName);
        const found = result.data?.[0];
        if (found) update.gameId = found.id;
      }
      if (tags !== undefined) update.tags = tags;

      if (Object.keys(update).length > 0) {
        await api.channels.updateChannelInfo(user.id, update as Parameters<typeof api.channels.updateChannelInfo>[1]);
      }

      reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('scope') || message.includes('channel:manage:broadcast')) {
        reply.status(403).send({ error: 'missing_scope', message: 'Tu token de Twitch no tiene el permiso necesario (channel:manage:broadcast). Desconectá y volvé a conectar Twitch en Configuración para actualizar los permisos.' });
      } else {
        reply.status(500).send({ error: message || 'Failed to update stream info' });
      }
    }
  });

  // Search games / categories
  app.get('/hud/games/search', async (req, reply) => {
    const { query } = req.query as { query?: string };
    if (!query) return reply.status(400).send({ error: 'Missing query' });

    try {
      if (!authProvider) return reply.status(503).send({ error: 'Not authenticated' });
      const api = new ApiClient({ authProvider });
      const result = await api.search.searchCategories(query);
      reply.send(result.data.map((g) => ({ id: g.id, name: g.name, boxArtUrl: g.boxArtUrl })));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      reply.status(500).send({ error: message });
    }
  });

  // Get current channel tags and stream info
  app.get('/hud/tags/:channel', async (req, reply) => {
    const { channel } = req.params as { channel: string };
    if (!channel && !currentUser?.login) return reply.status(400).send({ error: 'Missing channel' });

    try {
      if (!authProvider) return reply.status(503).send({ error: 'Not authenticated' });
      const api = new ApiClient({ authProvider });
      const cleanName = String(channel || '').trim().replace(/^[@#]/, '').toLowerCase();
      const user =
        (cleanName && /^[a-z0-9_]{2,25}$/.test(cleanName)
          ? await api.users.getUserByName(cleanName).catch(() => null)
          : null) ??
        (currentUser?.login ? await api.users.getUserByName(currentUser.login).catch(() => null) : null);
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const [channelInfo, stream] = await Promise.all([
        api.channels.getChannelInfoById(user.id).catch(() => null),
        api.streams.getStreamByUserId(user.id).catch(() => null),
      ]);

      let allTags: Array<{ id: string; name: string; isAuto: boolean }> = [];
      const activeTags: string[] = channelInfo?.tags ?? [];
      if (allTags.length === 0 && activeTags.length > 0) {
        allTags = activeTags.map((tagId) => ({
          id: tagId,
          name: tagId.slice(0, 20),
          isAuto: false,
        }));
      }

      reply.send({
        allTags,
        activeTagIds: activeTags,
        title: stream?.title || channelInfo?.title || '',
        gameId: stream?.gameId || channelInfo?.gameId || null,
        gameName: stream?.gameName || channelInfo?.gameName || '',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tags';
      reply.status(500).send({ error: message });
    }
  });
}
