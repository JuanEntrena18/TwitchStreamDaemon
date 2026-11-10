import { FastifyInstance } from 'fastify';
import { ApiClient } from '@twurple/api';
import { getRawData } from '@twurple/common';
import { authProvider, currentUser } from '../auth/index.js';
import {
  fetchYouTubeChannelAnalytics,
  fetchYouTubeTopGamingTrends,
} from '../youtube/index.js';
import { getEvents } from '../activity/index.js';
import type {
  ViewerSnapshot,
  KpiOverview,
  KpiVideoArchiveItem,
  GamePerformance,
  BestSlot,
  ChatStats,
  StreamSummary,
  ChannelRecord,
  TwitchTopGame,
} from '@streamdaemon/shared';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateSessionViewers, restoreActiveSessions } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'kpi_snapshots.json');

const MAX_SNAPSHOTS = 120;
let snapshots = new Map<string, ViewerSnapshot[]>();

const chatMessageCount = new Map<string, number>();
const twitchChatMessageCount = new Map<string, number>();
const youtubeChatMessageCount = new Map<string, number>();
const cumulativePlatformMsgs = new Map<string, { twitch: number; youtube: number }>();
const uniqueChattersSet = new Map<string, Set<string>>();
const topChattersMap = new Map<
  string,
  Map<string, { count: number; platform: 'twitch' | 'youtube' }>
>();
let chatMessageInterval: ReturnType<typeof setInterval> | null = null;

export function resetChatCounter(channel: string) {
  const key = (channel || 'global').toLowerCase();
  chatMessageCount.set(key, 0);
  twitchChatMessageCount.set(key, 0);
  youtubeChatMessageCount.set(key, 0);
  if (!uniqueChattersSet.has(key)) {
    uniqueChattersSet.set(key, new Set());
  } else {
    uniqueChattersSet.get(key)!.clear();
  }
}

export function incrementChatCounter(
  channel: string,
  user?: string,
  platform: 'twitch' | 'youtube' = 'twitch',
) {
  const key = (channel || 'global').toLowerCase();
  chatMessageCount.set(key, (chatMessageCount.get(key) || 0) + 1);
  if (platform === 'youtube') {
    youtubeChatMessageCount.set(key, (youtubeChatMessageCount.get(key) || 0) + 1);
  } else {
    twitchChatMessageCount.set(key, (twitchChatMessageCount.get(key) || 0) + 1);
  }

  const cum = cumulativePlatformMsgs.get(key) || { twitch: 0, youtube: 0 };
  if (platform === 'youtube') cum.youtube += 1;
  else cum.twitch += 1;
  cumulativePlatformMsgs.set(key, cum);

  if (user) {
    if (!uniqueChattersSet.has(key)) {
      uniqueChattersSet.set(key, new Set());
    }
    uniqueChattersSet.get(key)!.add(user);

    if (!topChattersMap.has(key)) {
      topChattersMap.set(key, new Map());
    }
    const chMap = topChattersMap.get(key)!;
    const prev = chMap.get(user);
    chMap.set(user, {
      count: (prev?.count || 0) + 1,
      platform: prev?.platform || platform,
    });
  }
}

export function getChatMessagesPerMinute(channel: string): number {
  const key = (channel || 'global').toLowerCase();
  let total = chatMessageCount.get(key) || 0;
  if (total === 0) {
    for (const v of chatMessageCount.values()) total += v;
  }
  return total;
}

export function getUniqueChattersCount(channel: string): number {
  const key = (channel || 'global').toLowerCase();
  const merged = new Set<string>();
  const direct = uniqueChattersSet.get(key);
  if (direct) direct.forEach((u) => merged.add(u));
  for (const s of uniqueChattersSet.values()) {
    s.forEach((u) => merged.add(u));
  }
  return merged.size;
}

function loadSnapshots() {
  try {
    if (fs.existsSync(SNAPSHOTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf-8'));
      snapshots = new Map(Object.entries(data));
    }
  } catch (e) {
    console.error('Failed to load KPI snapshots:', e);
  }
}

function saveSnapshots() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = Object.fromEntries(snapshots.entries());
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save KPI snapshots:', e);
  }
}

export function recordSnapshot(
  channel: string,
  viewers: number,
  chattersActive: number,
  twitchViewers?: number,
  youtubeViewers?: number,
) {
  const normChannel = (channel || 'global').toLowerCase();
  if (!snapshots.has(normChannel)) snapshots.set(normChannel, []);
  const list = snapshots.get(normChannel)!;

  let twMsgs = twitchChatMessageCount.get(normChannel) || 0;
  let ytMsgs = youtubeChatMessageCount.get(normChannel) || 0;
  if (twMsgs === 0 && ytMsgs === 0) {
    for (const v of twitchChatMessageCount.values()) twMsgs += v;
    for (const v of youtubeChatMessageCount.values()) ytMsgs += v;
  }
  const messagesPerMin = twMsgs + ytMsgs;
  const uniqueChatters = getUniqueChattersCount(normChannel);

  list.push({
    timestamp: Date.now(),
    viewers,
    twitchViewers: twitchViewers ?? viewers,
    youtubeViewers: youtubeViewers ?? 0,
    chattersActive: Math.max(chattersActive, uniqueChatters),
    messagesPerMin,
    twitchMessagesPerMin: twMsgs,
    youtubeMessagesPerMin: ytMsgs,
    uniqueChatters,
  });

  while (list.length > MAX_SNAPSHOTS) list.shift();
  saveSnapshots();

  if (currentUser && currentUser.login.toLowerCase() === normChannel) {
    updateSessionViewers(currentUser.id, viewers).catch(() => {});
  }
}

function getChannelSnapshots(channel: string): ViewerSnapshot[] {
  const norm = (channel || 'global').toLowerCase();
  const direct = snapshots.get(norm);
  if (direct && direct.length > 0) return direct;

  // Fallback: merge all recorded channel buckets in this local single-streamer instance
  const all: ViewerSnapshot[] = [];
  for (const list of snapshots.values()) {
    all.push(...list);
  }
  return all.sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_SNAPSHOTS);
}

const VALID_PERIODS = ['7d', '30d', '90d', 'all'] as const;
type Period = (typeof VALID_PERIODS)[number];
type PlatformFilter = 'multi' | 'twitch' | 'youtube';

function parsePeriod(p?: string): Period {
  return VALID_PERIODS.includes(p as Period) ? (p as Period) : '30d';
}

function parsePlatform(p?: string): PlatformFilter {
  if (p === 'twitch' || p === 'youtube' || p === 'multi') return p;
  return 'multi';
}

function getStartDate(period: Period): Date | undefined {
  if (period === 'all') return undefined;
  const days = parseInt(period, 10);
  return new Date(Date.now() - days * 86400000);
}

function getPreviousPeriodStartDate(period: Period): Date | undefined {
  if (period === 'all') return undefined;
  const days = parseInt(period, 10);
  return new Date(Date.now() - days * 2 * 86400000);
}

function calculateDelta(current: number, previous: number): number | undefined {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

async function resolveTwitchUser(channel: string) {
  if (!authProvider) return null;
  try {
    const apiClient = new ApiClient({ authProvider });
    const clean = String(channel || '')
      .trim()
      .replace(/^[@#]/, '')
      .toLowerCase();
    const user =
      (clean && /^[a-z0-9_]{2,25}$/.test(clean)
        ? await apiClient.users.getUserByName(clean).catch(() => null)
        : null) ??
      (currentUser?.login
        ? await apiClient.users.getUserByName(currentUser.login).catch(() => null)
        : null);
    if (!user) return null;
    return { apiClient, user };
  } catch {
    return null;
  }
}

export function setupKpi(app: FastifyInstance) {
  loadSnapshots();
  restoreActiveSessions();

  if (!chatMessageInterval) {
    chatMessageInterval = setInterval(() => {
      chatMessageCount.clear();
      twitchChatMessageCount.clear();
      youtubeChatMessageCount.clear();
    }, 60000);
  }

  /* ──────────────────────────────────────────────────────────────────────────
     1. OVERVIEW KPI (Multi-Platform: Twitch + YouTube Live)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/overview/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { period: periodStr, platform: platStr } = req.query as {
        period?: string;
        platform?: string;
      };
      const period = parsePeriod(periodStr || '30d');
      const platform = parsePlatform(platStr);

      const startDate = getStartDate(period);
      const prevStartDate = getPreviousPeriodStartDate(period);

      const includeTwitch = platform === 'multi' || platform === 'twitch';
      const includeYouTube = platform === 'multi' || platform === 'youtube';

      const [twResolved, ytAnalytics] = await Promise.all([
        includeTwitch ? resolveTwitchUser(channel) : Promise.resolve(null),
        includeYouTube ? fetchYouTubeChannelAnalytics() : Promise.resolve(null),
      ]);

      // Twitch Data
      let twFollowers = 0;
      let twSubs = 0;
      const twArchives: KpiVideoArchiveItem[] = [];

      if (twResolved) {
        const { apiClient, user } = twResolved;
        const [followInfo, subInfo, videos] = await Promise.all([
          apiClient.channels.getChannelFollowers(user.id, user.id).catch(() => ({ total: 0 })),
          apiClient.subscriptions.getSubscriptions(user.id).catch(() => ({ total: 0 })),
          apiClient.videos
            .getVideosByUser(user.id, { type: 'archive', period: 'all', limit: 60 })
            .catch(() => ({ data: [] })),
        ]);
        twFollowers = followInfo.total;
        twSubs = subInfo.total;

        for (const v of videos.data) {
          const raw = getRawData(v) as unknown as Record<string, unknown>;
          const gameName = String(raw.game_name || 'Twitch Stream');
          twArchives.push({
            id: v.id,
            platform: 'twitch',
            title: v.title,
            categoryName: gameName,
            publishedAt: v.creationDate.toISOString(),
            durationSeconds: v.durationInSeconds,
            views: v.views,
            peakConcurrentViewers: v.views,
            thumbnailUrl: v.thumbnailUrl
              ? v.thumbnailUrl.replace('%{width}', '320').replace('%{height}', '180')
              : undefined,
            url: v.url || `https://www.twitch.tv/videos/${v.id}`,
            isLiveArchive: true,
          });
        }
      }

      // YouTube Data
      const ytSubscribers = ytAnalytics?.subscribers ?? 0;
      const ytTotalChannelViews = ytAnalytics?.totalChannelViews ?? 0;
      const ytVideoCount = ytAnalytics?.videoCount ?? 0;
      const ytArchives: KpiVideoArchiveItem[] = ytAnalytics?.archives ?? [];

      const allEvents = getEvents(channel.toLowerCase());
      const scopedEvents = allEvents.filter((e) => {
        const ep = e.platform || 'twitch';
        if (platform === 'twitch') return ep === 'twitch';
        if (platform === 'youtube') return ep === 'youtube';
        return true;
      });

      const computeWindowMetrics = (items: KpiVideoArchiveItem[], start?: Date, end?: Date) => {
        const filtered = items.filter((item) => {
          const d = new Date(item.publishedAt);
          if (start && d < start) return false;
          if (end && d >= end) return false;
          return true;
        });

        let hours = 0;
        let views = 0;
        let peak = 0;
        let likes = 0;
        let comments = 0;

        for (const item of filtered) {
          hours += (item.durationSeconds || 0) / 3600;
          views += item.views || 0;
          peak = Math.max(peak, item.peakConcurrentViewers || item.views || 0);
          likes += item.likes || 0;
          comments += item.comments || 0;
        }

        const winEvents = scopedEvents.filter((e) => {
          if (start && e.timestamp < start.getTime()) return false;
          if (end && e.timestamp >= end.getTime()) return false;
          return true;
        });

        const fGained = winEvents.filter((e) => e.type === 'follow').length;
        const sGained = winEvents.filter(
          (e) => e.type === 'sub' || e.type === 'resub' || e.type === 'gift',
        ).length;
        const bDonated = winEvents
          .filter((e) => e.type === 'cheer')
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const avgViewers = filtered.length > 0 ? Math.round(views / filtered.length) : 0;
        const estimatedRevenue = Math.round((sGained * 2.49 + bDonated * 0.01) * 100) / 100;

        return {
          streams: filtered.length,
          hours,
          views,
          peak,
          likes,
          comments,
          avgViewers,
          fGained,
          sGained,
          bDonated,
          estimatedRevenue,
        };
      };

      const activeArchives = [
        ...(includeTwitch ? twArchives : []),
        ...(includeYouTube ? ytArchives : []),
      ].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      const curr = computeWindowMetrics(activeArchives, startDate);
      const prev =
        period !== 'all' ? computeWindowMetrics(activeArchives, prevStartDate, startDate) : curr;

      const twCurr = computeWindowMetrics(twArchives, startDate);
      const ytCurr = computeWindowMetrics(ytArchives, startDate);

      const combinedFollowers =
        (includeTwitch ? twFollowers : 0) + (includeYouTube ? ytSubscribers : 0);
      const combinedSubs = includeTwitch ? twSubs : 0;
      const subToFollowRatio = combinedFollowers > 0 ? combinedSubs / combinedFollowers : 0;
      const engagementRate =
        curr.views > 0
          ? Math.round(((curr.likes + curr.comments) / curr.views) * 1000) / 10
          : 0;

      const overview: KpiOverview = {
        channel,
        platform,
        followers: combinedFollowers,
        subscribers: combinedSubs,
        youtubeSubscribers: ytSubscribers,
        youtubeTotalChannelViews: ytTotalChannelViews,
        youtubeVideoCount: ytVideoCount,
        subToFollowRatio: Math.round(subToFollowRatio * 100) / 100,
        avgViewers: curr.avgViewers,
        peakViewers: curr.peak,
        totalViews:
          curr.views > 0
            ? curr.views
            : platform === 'youtube'
              ? ytTotalChannelViews
              : curr.views,
        totalHoursStreamed: Math.round(curr.hours * 10) / 10,
        followersGained: curr.fGained,
        subsGained: curr.sGained,
        bitsDonated: curr.bDonated,
        estimatedRevenue: curr.estimatedRevenue,
        streamsThisPeriod: curr.streams,
        totalLikes: curr.likes,
        totalComments: curr.comments,
        engagementRate,
        isLive: Boolean(ytAnalytics?.isLive),
        platformBreakdown: {
          twitch: {
            followers: twFollowers,
            subscribers: twSubs,
            totalViews: twCurr.views,
            streams: twCurr.streams,
            hours: Math.round(twCurr.hours * 10) / 10,
            avgViewers: twCurr.avgViewers,
            peakViewers: twCurr.peak,
          },
          youtube: {
            subscribers: ytSubscribers,
            totalChannelViews: ytTotalChannelViews,
            videoCount: ytVideoCount,
            periodViews: ytCurr.views,
            periodLikes: ytCurr.likes,
            periodComments: ytCurr.comments,
            videos: ytCurr.streams,
            hours: Math.round(ytCurr.hours * 10) / 10,
            avgViews: ytCurr.avgViewers,
            peakViews: ytCurr.peak,
          },
        },
        recentArchives: activeArchives.slice(0, 24),
      };

      if (period !== 'all') {
        overview.avgViewersDelta = calculateDelta(curr.avgViewers, prev.avgViewers);
        overview.peakViewersDelta = calculateDelta(curr.peak, prev.peak);
        overview.totalViewsDelta = calculateDelta(curr.views, prev.views);
        overview.totalHoursStreamedDelta = calculateDelta(curr.hours, prev.hours);
        overview.followersGainedDelta = calculateDelta(curr.fGained, prev.fGained);
        overview.subsGainedDelta = calculateDelta(curr.sGained, prev.sGained);
        overview.bitsDonatedDelta = calculateDelta(curr.bDonated, prev.bDonated);
        overview.estimatedRevenueDelta = calculateDelta(
          curr.estimatedRevenue,
          prev.estimatedRevenue,
        );
        overview.streamsThisPeriodDelta = calculateDelta(curr.streams, prev.streams);
        overview.totalLikesDelta = calculateDelta(curr.likes, prev.likes);
        overview.totalCommentsDelta = calculateDelta(curr.comments, prev.comments);
      }

      return overview;
    } catch (err) {
      req.log.error(err, 'KPI overview failed');
      return reply.status(500).send({ error: 'Failed to fetch KPI data' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     2. REAL-TIME VIEWERS & AUDIENCE HISTORY
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/viewers-history/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const list = getChannelSnapshots(channel.toLowerCase());
      const last = list.length > 0 ? list[list.length - 1] : null;
      return {
        channel,
        snapshots: list,
        activeViewers: last?.viewers ?? 0,
        twitchViewers: last?.twitchViewers ?? 0,
        youtubeViewers: last?.youtubeViewers ?? 0,
      };
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch viewer history' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     3. CHAT ANALYTICS & TOP CHATTERS (Twitch IRC + YouTube Live Chat)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/chat-stats/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const list = getChannelSnapshots(channel.toLowerCase());

      // Merge top chatters across all buckets in this local session
      const mergedTop = new Map<string, { count: number; platform: 'twitch' | 'youtube' }>();
      for (const chMap of topChattersMap.values()) {
        for (const [user, info] of chMap.entries()) {
          const prev = mergedTop.get(user);
          mergedTop.set(user, {
            count: (prev?.count || 0) + info.count,
            platform: prev?.platform || info.platform,
          });
        }
      }

      const topChatters = Array.from(mergedTop.entries())
        .map(([user, info]) => ({
          user,
          messageCount: info.count,
          platform: info.platform,
        }))
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, 15);

      let twitchMessages = 0;
      let youtubeMessages = 0;
      for (const c of cumulativePlatformMsgs.values()) {
        twitchMessages += c.twitch;
        youtubeMessages += c.youtube;
      }

      const chatStats: ChatStats = {
        avgMessagesPerMin: 0,
        peakMessagesPerMin: 0,
        totalMessages: twitchMessages + youtubeMessages,
        twitchMessages,
        youtubeMessages,
        uniqueChatters: getUniqueChattersCount(channel),
        avgEngagementRatio: 0,
        topChatters,
        timeline: [],
      };

      if (list.length === 0) return chatStats;

      let totalEngagement = 0;
      let engagementCount = 0;
      let snapshotMsgSum = 0;

      for (const snap of list) {
        const msgs = snap.messagesPerMin || 0;
        snapshotMsgSum += msgs;
        chatStats.peakMessagesPerMin = Math.max(chatStats.peakMessagesPerMin, msgs);
        chatStats.uniqueChatters = Math.max(chatStats.uniqueChatters, snap.uniqueChatters || 0);

        const engagement =
          snap.viewers > 0 ? ((snap.chattersActive || 0) / snap.viewers) * 100 : 0;
        if (snap.viewers > 0) {
          totalEngagement += engagement;
          engagementCount++;
        }

        chatStats.timeline.push({
          timestamp: snap.timestamp,
          messagesPerMin: msgs,
          twitchMessagesPerMin: snap.twitchMessagesPerMin ?? msgs,
          youtubeMessagesPerMin: snap.youtubeMessagesPerMin ?? 0,
          engagement: Math.round(engagement),
        });
      }

      if (chatStats.totalMessages === 0) {
        chatStats.totalMessages = snapshotMsgSum;
      }
      chatStats.avgMessagesPerMin = Math.round(snapshotMsgSum / Math.max(1, list.length));
      chatStats.avgEngagementRatio =
        engagementCount > 0 ? Math.round(totalEngagement / engagementCount) : 0;

      return chatStats;
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch chat stats' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     4. POST-STREAM REPORT & ARCHIVE INSPECTOR (Twitch VODs + YouTube Streams)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/stream-summary/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { platform: platStr, videoId } = req.query as {
        platform?: string;
        videoId?: string;
      };
      const platform = parsePlatform(platStr);
      const includeTwitch = platform === 'multi' || platform === 'twitch';
      const includeYouTube = platform === 'multi' || platform === 'youtube';

      const [twResolved, ytAnalytics] = await Promise.all([
        includeTwitch ? resolveTwitchUser(channel) : Promise.resolve(null),
        includeYouTube ? fetchYouTubeChannelAnalytics() : Promise.resolve(null),
      ]);

      const archives: KpiVideoArchiveItem[] = [];

      if (twResolved) {
        const videos = await twResolved.apiClient.videos
          .getVideosByUser(twResolved.user.id, { type: 'archive', period: 'all', limit: 25 })
          .catch(() => ({ data: [] }));
        for (const v of videos.data) {
          const raw = getRawData(v) as unknown as Record<string, unknown>;
          archives.push({
            id: v.id,
            platform: 'twitch',
            title: v.title,
            categoryName: String(raw.game_name || 'Twitch Stream'),
            publishedAt: v.creationDate.toISOString(),
            durationSeconds: v.durationInSeconds,
            views: v.views,
            peakConcurrentViewers: v.views,
            thumbnailUrl: v.thumbnailUrl
              ? v.thumbnailUrl.replace('%{width}', '320').replace('%{height}', '180')
              : undefined,
            url: v.url || `https://www.twitch.tv/videos/${v.id}`,
            isLiveArchive: true,
          });
        }
      }

      if (ytAnalytics?.archives?.length) {
        archives.push(...ytAnalytics.archives);
      }

      archives.sort(
        (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );

      const target =
        (videoId ? archives.find((a) => a.id === videoId) : null) || archives[0] || null;

      if (!target) {
        return reply.status(404).send({ error: 'No streams found', archives: [] });
      }

      const events = getEvents(channel.toLowerCase());
      const startTime = new Date(target.publishedAt).getTime();
      const endTime = startTime + Math.max(target.durationSeconds, 3600) * 1000;
      const streamEvents = events.filter(
        (e) =>
          e.timestamp >= startTime &&
          e.timestamp <= endTime &&
          (!e.platform || e.platform === target.platform),
      );

      const followersGained = streamEvents.filter((e) => e.type === 'follow').length;
      const subsGained = streamEvents.filter(
        (e) => e.type === 'sub' || e.type === 'resub' || e.type === 'gift',
      ).length;
      const bitsDonated = streamEvents
        .filter((e) => e.type === 'cheer')
        .reduce((sum, e) => sum + (e.amount || 0), 0);
      const estimatedRevenue = Math.round((subsGained * 2.49 + bitsDonated * 0.01) * 100) / 100;

      const avgHistoricalViews =
        archives.length > 0
          ? Math.round(archives.reduce((s, a) => s + a.views, 0) / archives.length)
          : target.views;
      const avgHistoricalDuration =
        archives.length > 0
          ? Math.round(archives.reduce((s, a) => s + a.durationSeconds, 0) / archives.length)
          : target.durationSeconds;

      const summary: StreamSummary & { archives?: KpiVideoArchiveItem[] } = {
        id: target.id,
        platform: target.platform,
        channel,
        streamTitle: target.title,
        gameName: target.categoryName,
        startedAt: target.publishedAt,
        duration: target.durationSeconds,
        avgViewers: target.views,
        peakViewers: target.peakConcurrentViewers || target.views,
        minViewers: 0,
        peakTimestamp: startTime,
        avgChatters: 0,
        avgEngagement:
          target.views > 0 && (target.likes || target.comments)
            ? Math.round((((target.likes || 0) + (target.comments || 0)) / target.views) * 1000) /
              10
            : 0,
        followersGained,
        subsGained,
        bitsDonated,
        estimatedRevenue,
        totalChatMessages: 0,
        uniqueChatters: 0,
        likes: target.likes ?? 0,
        comments: target.comments ?? 0,
        thumbnailUrl: target.thumbnailUrl,
        url: target.url,
        avgViewersVsAvg: calculateDelta(target.views, avgHistoricalViews),
        durationVsAvg: calculateDelta(target.durationSeconds, avgHistoricalDuration),
        archives: archives.slice(0, 30),
      };

      return summary;
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch stream summary' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     5. CHANNEL RECORDS (Twitch + YouTube Milestones)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/records/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { platform: platStr } = req.query as { platform?: string };
      const platform = parsePlatform(platStr);
      const includeTwitch = platform === 'multi' || platform === 'twitch';
      const includeYouTube = platform === 'multi' || platform === 'youtube';

      const [twResolved, ytAnalytics] = await Promise.all([
        includeTwitch ? resolveTwitchUser(channel) : Promise.resolve(null),
        includeYouTube ? fetchYouTubeChannelAnalytics() : Promise.resolve(null),
      ]);

      const records: ChannelRecord[] = [];

      if (twResolved) {
        const videos = await twResolved.apiClient.videos
          .getVideosByUser(twResolved.user.id, { type: 'archive', period: 'all', limit: 100 })
          .catch(() => ({ data: [] }));

        if (videos.data.length > 0) {
          let maxViewsVideo = videos.data[0];
          let longestVideo = videos.data[0];

          for (const video of videos.data) {
            if (video.views > maxViewsVideo.views) maxViewsVideo = video;
            if (video.durationInSeconds > longestVideo.durationInSeconds) longestVideo = video;
          }

          records.push({
            platform: 'twitch',
            label: 'Emisión con más visualizaciones (Twitch)',
            value: maxViewsVideo.views.toLocaleString('es-ES'),
            streamTitle: maxViewsVideo.title,
            date: maxViewsVideo.creationDate.toISOString(),
            url: maxViewsVideo.url || `https://www.twitch.tv/videos/${maxViewsVideo.id}`,
            icon: '🟣',
          });

          const hours = Math.floor(longestVideo.durationInSeconds / 3600);
          const minutes = Math.floor((longestVideo.durationInSeconds % 3600) / 60);

          records.push({
            platform: 'twitch',
            label: 'Directo más largo en Twitch',
            value: `${hours}h ${minutes}m`,
            streamTitle: longestVideo.title,
            date: longestVideo.creationDate.toISOString(),
            url: longestVideo.url || `https://www.twitch.tv/videos/${longestVideo.id}`,
            icon: '⏱️',
          });
        }
      }

      if (ytAnalytics) {
        records.push({
          platform: 'youtube',
          label: 'Visualizaciones históricas en YouTube',
          value: ytAnalytics.totalChannelViews.toLocaleString('es-ES'),
          streamTitle: `${ytAnalytics.displayName} · ${ytAnalytics.videoCount} vídeos publicados`,
          icon: '🔴',
        });

        if (ytAnalytics.archives.length > 0) {
          let topViewedYt = ytAnalytics.archives[0];
          let topLikedYt = ytAnalytics.archives[0];
          let topCommentedYt = ytAnalytics.archives[0];
          let longestYt = ytAnalytics.archives[0];

          for (const v of ytAnalytics.archives) {
            if (v.views > topViewedYt.views) topViewedYt = v;
            if ((v.likes || 0) > (topLikedYt.likes || 0)) topLikedYt = v;
            if ((v.comments || 0) > (topCommentedYt.comments || 0)) topCommentedYt = v;
            if (v.durationSeconds > longestYt.durationSeconds) longestYt = v;
          }

          records.push({
            platform: 'youtube',
            label: 'Vídeo / directo más visto en YouTube',
            value: `${topViewedYt.views.toLocaleString('es-ES')} vistas`,
            streamTitle: topViewedYt.title,
            date: topViewedYt.publishedAt,
            url: topViewedYt.url,
            icon: '🔥',
          });

          if ((topLikedYt.likes || 0) > 0) {
            records.push({
              platform: 'youtube',
              label: 'Récord de «Me gusta» en YouTube',
              value: `${(topLikedYt.likes || 0).toLocaleString('es-ES')} likes`,
              streamTitle: topLikedYt.title,
              date: topLikedYt.publishedAt,
              url: topLikedYt.url,
              icon: '👍',
            });
          }

          if ((topCommentedYt.comments || 0) > 0) {
            records.push({
              platform: 'youtube',
              label: 'Mayor interacción de comentarios (YT)',
              value: `${(topCommentedYt.comments || 0).toLocaleString('es-ES')} comentarios`,
              streamTitle: topCommentedYt.title,
              date: topCommentedYt.publishedAt,
              url: topCommentedYt.url,
              icon: '💬',
            });
          }

          if (longestYt.durationSeconds > 0) {
            const h = Math.floor(longestYt.durationSeconds / 3600);
            const m = Math.floor((longestYt.durationSeconds % 3600) / 60);
            records.push({
              platform: 'youtube',
              label: 'Emisión / contenido más extenso en YouTube',
              value: h > 0 ? `${h}h ${m}m` : `${m}m`,
              streamTitle: longestYt.title,
              date: longestYt.publishedAt,
              url: longestYt.url,
              icon: '🎬',
            });
          }
        }
      }

      return { channel, records };
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch channel records' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     6. GAME & CATEGORY PERFORMANCE (Twitch Categories + YouTube Categories)
     ────────────────────────────────────────────────────────────────────────── */
  async function fetchCombinedGamePerformance(
    channel: string,
    platform: PlatformFilter,
    startDate?: Date,
    forceRefresh = false,
  ): Promise<GamePerformance[]> {
    const includeTwitch = platform === 'multi' || platform === 'twitch';
    const includeYouTube = platform === 'multi' || platform === 'youtube';

    const [twResolved, ytAnalytics] = await Promise.all([
      includeTwitch ? resolveTwitchUser(channel) : Promise.resolve(null),
      includeYouTube ? fetchYouTubeChannelAnalytics(forceRefresh) : Promise.resolve(null),
    ]);

    const results: GamePerformance[] = [];

    if (twResolved) {
      const { apiClient, user } = twResolved;
      const videos = await apiClient.videos
        .getVideosByUser(user.id, { type: 'archive', period: 'all', limit: 100 })
        .catch(() => ({ data: [] }));
      const filteredVideos = startDate
        ? videos.data.filter((v) => v.creationDate >= startDate)
        : videos.data;
      const events = getEvents(channel.toLowerCase());

      const gameMap = new Map<
        string,
        {
          views: number[];
          durations: number[];
          count: number;
          followersGained: number;
          boxArtUrl?: string;
        }
      >();

      for (const video of filteredVideos) {
        const raw = getRawData(video) as unknown as Record<string, unknown>;
        let gameName = String(raw.game_name || '');
        if (!gameName || gameName === 'Unknown') {
          if (raw.game_id) {
            try {
              const g = await apiClient.games.getGameById(String(raw.game_id));
              if (g) gameName = g.name;
            } catch {}
          }
          if (!gameName) gameName = 'General (Twitch)';
        }
        if (!gameMap.has(gameName)) {
          gameMap.set(gameName, { views: [], durations: [], count: 0, followersGained: 0 });
        }
        const entry = gameMap.get(gameName)!;
        entry.views.push(video.views);
        entry.durations.push(video.durationInSeconds);
        entry.count++;
        const startTime = video.creationDate.getTime();
        const endTime = startTime + video.durationInSeconds * 1000;
        entry.followersGained += events.filter(
          (e) =>
            e.timestamp >= startTime &&
            e.timestamp <= endTime &&
            e.type === 'follow' &&
            (e.platform || 'twitch') === 'twitch',
        ).length;
      }

      for (const gameName of gameMap.keys()) {
        try {
          const game = await apiClient.games.getGameByName(gameName);
          if (game) {
            gameMap.get(gameName)!.boxArtUrl = game.boxArtUrl
              .replace('{width}', '144')
              .replace('{height}', '192');
          }
        } catch {}
      }

      for (const [gameName, data] of gameMap.entries()) {
        const totalViews = data.views.reduce((a, b) => a + b, 0);
        results.push({
          platform: 'twitch',
          gameName,
          boxArtUrl: data.boxArtUrl,
          streamCount: data.count,
          totalViews,
          avgViewers: Math.round(totalViews / data.count),
          maxViewers: Math.max(...data.views),
          followersGained: data.followersGained,
          avgDuration: Math.round(data.durations.reduce((a, b) => a + b, 0) / data.count),
        });
      }
    }

    if (ytAnalytics?.archives?.length) {
      const filteredYt = startDate
        ? ytAnalytics.archives.filter((a) => new Date(a.publishedAt) >= startDate)
        : ytAnalytics.archives;

      const ytCatMap = new Map<
        string,
        {
          views: number[];
          durations: number[];
          likes: number;
          comments: number;
          count: number;
          thumb?: string;
        }
      >();

      for (const a of filteredYt) {
        const key = a.categoryName || 'Videojuegos (Gaming)';
        if (!ytCatMap.has(key)) {
          ytCatMap.set(key, {
            views: [],
            durations: [],
            likes: 0,
            comments: 0,
            count: 0,
            thumb: a.thumbnailUrl,
          });
        }
        const entry = ytCatMap.get(key)!;
        entry.views.push(a.views);
        entry.durations.push(a.durationSeconds);
        entry.likes += a.likes || 0;
        entry.comments += a.comments || 0;
        entry.count++;
      }

      for (const [catName, data] of ytCatMap.entries()) {
        const totalViews = data.views.reduce((a, b) => a + b, 0);
        results.push({
          platform: 'youtube',
          gameName: `${catName}`,
          boxArtUrl: data.thumb,
          streamCount: data.count,
          totalViews,
          avgViewers: Math.round(totalViews / data.count),
          maxViewers: Math.max(...data.views),
          followersGained: 0,
          totalLikes: data.likes,
          totalComments: data.comments,
          avgDuration: Math.round(data.durations.reduce((a, b) => a + b, 0) / data.count),
        });
      }
    }

    return results.sort((a, b) => b.totalViews - a.totalViews);
  }

  app.get('/kpi/game-performance/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { period: periodStr, platform: platStr } = req.query as {
        period?: string;
        platform?: string;
      };
      const period = parsePeriod(periodStr || 'all');
      const platform = parsePlatform(platStr);
      const games = await fetchCombinedGamePerformance(
        channel,
        platform,
        getStartDate(period),
        false,
      );
      return { channel, games };
    } catch (err) {
      req.log.error(err, 'Game performance failed');
      return reply.status(500).send({ error: 'Failed to fetch game performance' });
    }
  });

  app.post('/kpi/game-performance/:channel/refresh', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { platform: platStr } = (req.body || {}) as { platform?: string };
      const platform = parsePlatform(platStr);
      const games = await fetchCombinedGamePerformance(channel, platform, undefined, true);
      return { channel, games };
    } catch (err) {
      req.log.error(err, 'Game performance refresh failed');
      return reply.status(500).send({ error: 'Failed to refresh game performance' });
    }
  });

  /* ──────────────────────────────────────────────────────────────────────────
     7. BEST BROADCAST & UPLOAD SLOTS (Twitch + YouTube Schedule Intelligence)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/best-slots/:channel', async (req, reply) => {
    try {
      const { channel } = req.params as { channel: string };
      const { period: periodStr, platform: platStr } = req.query as {
        period?: string;
        platform?: string;
      };
      const period = parsePeriod(periodStr || 'all');
      const platform = parsePlatform(platStr);
      const startDate = getStartDate(period);

      const includeTwitch = platform === 'multi' || platform === 'twitch';
      const includeYouTube = platform === 'multi' || platform === 'youtube';

      const [twResolved, ytAnalytics] = await Promise.all([
        includeTwitch ? resolveTwitchUser(channel) : Promise.resolve(null),
        includeYouTube ? fetchYouTubeChannelAnalytics() : Promise.resolve(null),
      ]);

      const slotMap = new Map<string, { views: number[]; count: number }>();

      const addSlotEntry = (dateObj: Date, views: number) => {
        const dayOfWeek = dateObj.getDay();
        const hourStart = dateObj.getHours();
        const key = `${dayOfWeek}-${hourStart}`;
        if (!slotMap.has(key)) slotMap.set(key, { views: [], count: 0 });
        const entry = slotMap.get(key)!;
        entry.views.push(views);
        entry.count++;
      };

      if (twResolved) {
        const videos = await twResolved.apiClient.videos
          .getVideosByUser(twResolved.user.id, { type: 'archive', period: 'all', limit: 100 })
          .catch(() => ({ data: [] }));
        for (const v of videos.data) {
          if (startDate && v.creationDate < startDate) continue;
          addSlotEntry(v.creationDate, v.views);
        }
      }

      if (ytAnalytics?.archives?.length) {
        for (const a of ytAnalytics.archives) {
          const d = new Date(a.publishedAt);
          if (startDate && d < startDate) continue;
          addSlotEntry(d, a.views);
        }
      }

      const slots: BestSlot[] = Array.from(slotMap.entries())
        .map(([key, data]) => {
          const [dayOfWeek, hourStart] = key.split('-').map(Number);
          const totalViews = data.views.reduce((a, b) => a + b, 0);
          return {
            platform,
            dayOfWeek,
            hourStart,
            avgViewers: Math.round(totalViews / data.count),
            totalViews,
            streamCount: data.count,
          };
        })
        .sort((a, b) => b.avgViewers - a.avgViewers);

      return { channel, slots };
    } catch {
      return reply.status(500).send({ error: 'Failed to fetch best slots' });
    }
  });

  app.post('/kpi/viewer-snapshot', async (req, reply) => {
    const { channel, viewers, chattersActive, twitchViewers, youtubeViewers } = req.body as {
      channel: string;
      viewers: number;
      chattersActive: number;
      twitchViewers?: number;
      youtubeViewers?: number;
    };
    if (!channel) return reply.status(400).send({ error: 'Missing channel' });
    recordSnapshot(
      channel.toLowerCase(),
      viewers,
      chattersActive ?? 0,
      twitchViewers,
      youtubeViewers,
    );
    return { ok: true };
  });

  /* ──────────────────────────────────────────────────────────────────────────
     8. GLOBAL TRENDS RADAR (Twitch Top Games + YouTube Gaming Popular)
     ────────────────────────────────────────────────────────────────────────── */
  app.get('/kpi/top-twitch-games', async (req, reply) => {
    try {
      const { platform: platStr } = req.query as { platform?: string };
      const platform = parsePlatform(platStr);
      const includeTwitch = platform === 'multi' || platform === 'twitch';
      const includeYouTube = platform === 'multi' || platform === 'youtube';

      const results: TwitchTopGame[] = [];

      if (includeTwitch && authProvider) {
        try {
          const apiClient = new ApiClient({ authProvider });
          const topGamesPage = await apiClient.games.getTopGames({ limit: 12 });
          const twGames = await Promise.all(
            topGamesPage.data.map(async (game) => {
              try {
                const streamsPage = await apiClient.streams.getStreams({
                  game: game.id,
                  limit: 100,
                });
                const estimatedViewers = streamsPage.data.reduce(
                  (acc, stream) => acc + stream.viewers,
                  0,
                );
                return {
                  id: `tw-${game.id}`,
                  platform: 'twitch' as const,
                  name: game.name,
                  boxArtUrl: game.boxArtUrl.replace('{width}', '144').replace('{height}', '192'),
                  estimatedViewers,
                  activeStreamsCount: streamsPage.data.length,
                };
              } catch {
                return {
                  id: `tw-${game.id}`,
                  platform: 'twitch' as const,
                  name: game.name,
                  boxArtUrl: game.boxArtUrl.replace('{width}', '144').replace('{height}', '192'),
                  estimatedViewers: 0,
                };
              }
            }),
          );
          results.push(...twGames);
        } catch {}
      }

      if (includeYouTube) {
        const ytTrends = await fetchYouTubeTopGamingTrends().catch(() => []);
        results.push(...ytTrends);
      }

      results.sort((a, b) => b.estimatedViewers - a.estimatedViewers);
      return { games: results };
    } catch (err) {
      req.log.error(err, 'Failed to fetch top games');
      return reply.status(500).send({ error: 'Failed to fetch top games' });
    }
  });
}
