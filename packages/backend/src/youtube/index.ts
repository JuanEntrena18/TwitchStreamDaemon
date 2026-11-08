import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  YouTubeCredentialsSaveSchema,
  YouTubeQuickConnectSchema,
  YouTubeSimulateEventSchema,
  type PlatformUser,
  type HudData,
  type YouTubeCredentialsInfo,
} from '@streamdaemon/shared';
import { config } from '../config.js';
import { encryptToken, decryptToken } from '../auth/token-crypto.js';
import { prisma, currentUser as twitchUser } from '../auth/index.js';
import { getIO } from '../socket/index.js';
import { recordEvent } from '../activity/index.js';
import { addSubathonTime } from '../subathon/index.js';
import { checkCustomCommand } from '../commands/index.js';
import { checkMessage } from '../security/index.js';
import { enterGiveaway } from '../giveaways/index.js';
import { incrementChatCounter } from '../kpi/index.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const YT_STORE_FILE = path.join(DATA_DIR, 'youtube-auth.json');

const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

interface StoredYouTubeData {
  clientId?: string;
  clientSecretEnc?: string;
  apiKeyEnc?: string;
  session?: {
    authMode: 'oauth' | 'apikey';
    channelId: string;
    login: string;
    displayName: string;
    avatarUrl: string | null;
    accessTokenEnc?: string;
    refreshTokenEnc?: string;
    tokenExpiresAt?: number | null;
    liveBroadcastId?: string | null;
    liveChatId?: string | null;
  } | null;
}

export let currentYouTubeUser: PlatformUser | null = null;
export let youtubeAuthMode: 'oauth' | 'apikey' | null = null;

let storedData: StoredYouTubeData = {};
let chatPollTimeout: ReturnType<typeof setTimeout> | null = null;
let broadcastCheckInterval: ReturnType<typeof setInterval> | null = null;
let nextPageToken: string | undefined;
const processedMessageIds = new Set<string>();

interface YouTubeChannelItem {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
    };
  };
  statistics?: {
    subscriberCount?: string;
    viewCount?: string;
  };
}

interface YouTubeBroadcastItem {
  id: string;
  snippet?: {
    title?: string;
    liveChatId?: string;
    actualStartTime?: string;
    publishedAt?: string;
    categoryId?: string;
  };
  liveStreamingDetails?: {
    activeLiveChatId?: string;
    concurrentViewers?: string;
    actualStartTime?: string;
  };
}

interface YouTubeChatMessageItem {
  id: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    superChatDetails?: {
      amountMicros?: string;
      currency?: string;
      amountDisplayString?: string;
      userComment?: string;
      tier?: number;
    };
    superStickerDetails?: {
      amountMicros?: string;
      currency?: string;
      amountDisplayString?: string;
      tier?: number;
    };
    newSponsorDetails?: {
      memberLevelName?: string;
      isUpgrade?: boolean;
    };
    memberMilestoneChatDetails?: {
      memberLevelName?: string;
      memberMonth?: number;
      userComment?: string;
    };
    membershipGiftingDetails?: {
      giftMembershipsCount?: number;
      giftMembershipsLevelName?: string;
    };
  };
  authorDetails?: {
    channelId?: string;
    displayName?: string;
    profileImageUrl?: string;
    isVerified?: boolean;
    isChatOwner?: boolean;
    isChatSponsor?: boolean;
    isChatModerator?: boolean;
  };
}

const SUPERCHAT_TIER_COLORS: Record<number, string> = {
  1: '#1565c0',
  2: '#00b8d4',
  3: '#00bfa5',
  4: '#ffb300',
  5: '#e65100',
  6: '#c2185b',
  7: '#d00000',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStoredYouTubeData(): StoredYouTubeData {
  try {
    if (fs.existsSync(YT_STORE_FILE)) {
      return JSON.parse(fs.readFileSync(YT_STORE_FILE, 'utf-8')) as StoredYouTubeData;
    }
  } catch (err) {
    logger.warn({ err }, '[YouTube] Failed to load youtube-auth.json');
  }
  return {};
}

function saveStoredYouTubeData() {
  try {
    ensureDataDir();
    fs.writeFileSync(YT_STORE_FILE, JSON.stringify(storedData, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err }, '[YouTube] Failed to save youtube-auth.json');
  }
}

function getEffectiveClientId(): string {
  return storedData.clientId?.trim() || config.YOUTUBE_CLIENT_ID || '';
}

function getEffectiveClientSecret(): string {
  if (storedData.clientSecretEnc) {
    try {
      return decryptToken(storedData.clientSecretEnc);
    } catch {}
  }
  return config.YOUTUBE_CLIENT_SECRET || '';
}

function getEffectiveApiKey(): string {
  if (storedData.apiKeyEnc) {
    try {
      return decryptToken(storedData.apiKeyEnc);
    } catch {}
  }
  return config.YOUTUBE_API_KEY || '';
}

function getRedirectUri(): string {
  const port = config.PORT || '3000';
  return `http://localhost:${port}/auth/youtube/callback`;
}

export function getYouTubeCredentialsInfo(): YouTubeCredentialsInfo {
  const cid = getEffectiveClientId();
  const csec = getEffectiveClientSecret();
  const key = getEffectiveApiKey();
  return {
    hasClientId: Boolean(cid),
    hasClientSecret: Boolean(csec),
    hasApiKey: Boolean(key),
    clientIdPreview: cid ? `${cid.slice(0, 12)}...${cid.slice(-6)}` : '',
    redirectUri: getRedirectUri(),
  };
}

/**
 * Returns the active broadcast room channel slug (Twitch login if connected, otherwise YouTube login)
 * so all 57+ overlays joined to `channel:<slug>` receive YouTube events seamlessly.
 */
export function getTargetRoomChannel(explicitChannel?: string): string {
  if (explicitChannel) return explicitChannel.replace(/^[@#]/, '').toLowerCase();
  if (twitchUser?.login) return twitchUser.login.toLowerCase();
  if (currentYouTubeUser?.login) return currentYouTubeUser.login.toLowerCase();
  return '';
}

async function getValidAccessToken(): Promise<string | null> {
  const sess = storedData.session;
  if (!sess || sess.authMode !== 'oauth' || !sess.accessTokenEnc) return null;

  let accessToken = '';
  try {
    accessToken = decryptToken(sess.accessTokenEnc);
  } catch {
    return null;
  }

  const expiresAt = sess.tokenExpiresAt ?? 0;
  if (expiresAt > Date.now() + 60_000) {
    return accessToken;
  }

  // Refresh OAuth token if expired
  if (!sess.refreshTokenEnc) return accessToken;
  const clientId = getEffectiveClientId();
  const clientSecret = getEffectiveClientSecret();
  if (!clientId || !clientSecret) return accessToken;

  try {
    const refreshToken = decryptToken(sess.refreshTokenEnc);
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!res.ok) return accessToken;
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    sess.accessTokenEnc = encryptToken(data.access_token);
    sess.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    saveStoredYouTubeData();
    return data.access_token;
  } catch (err) {
    logger.warn({ err }, '[YouTube] Token refresh failed');
    return accessToken;
  }
}

async function ytApiFetch<T>(endpoint: string, params: Record<string, string>, init?: RequestInit): Promise<T | null> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  const token = await getValidAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    const apiKey = getEffectiveApiKey();
    if (!apiKey) return null;
    url.searchParams.set('key', apiKey);
  }

  try {
    const res = await fetch(url.toString(), { ...init, headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn({ endpoint, status: res.status, errText: errText.slice(0, 200) }, '[YouTube] API error');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ endpoint, err }, '[YouTube] Fetch failed');
    return null;
  }
}

async function ensurePrismaUserForYouTube(ytUser: PlatformUser) {
  try {
    const syntheticId = `yt:${ytUser.id}`;
    await prisma.user.upsert({
      where: { twitchId: syntheticId },
      update: {
        login: ytUser.login,
        displayName: ytUser.displayName,
        avatarUrl: ytUser.avatarUrl,
      },
      create: {
        twitchId: syntheticId,
        login: ytUser.login,
        displayName: ytUser.displayName,
        avatarUrl: ytUser.avatarUrl,
        accessToken: encryptToken('youtube-session'),
        refreshToken: encryptToken('youtube-session'),
      },
    });
  } catch (err) {
    logger.warn({ err }, '[YouTube] Non-fatal Prisma user sync warning');
  }
}

function normalizeHandleToLogin(customUrl?: string, title?: string, id?: string): string {
  if (customUrl) {
    return customUrl.replace(/^@/, '').toLowerCase();
  }
  if (title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (slug) return slug;
  }
  return (id || 'youtube').toLowerCase();
}

/* ──────────────────────────────────────────────────────────
   ACTIVE BROADCAST & LIVE CHAT DISCOVERY (LOW QUOTA)
────────────────────────────────────────────────────────── */
async function discoverActiveBroadcast(): Promise<{ broadcastId: string | null; liveChatId: string | null }> {
  if (!currentYouTubeUser) return { broadcastId: null, liveChatId: null };

  // 1. If OAuth is active, liveBroadcasts.list(broadcastStatus=active) costs only 1 quota unit!
  if (youtubeAuthMode === 'oauth') {
    const data = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('liveBroadcasts', {
      part: 'snippet,status,contentDetails',
      broadcastStatus: 'active',
      maxResults: '1',
    });
    const active = data?.items?.[0];
    if (active) {
      const liveChatId = active.snippet?.liveChatId || null;
      currentYouTubeUser.liveBroadcastId = active.id;
      currentYouTubeUser.liveChatId = liveChatId;
      return { broadcastId: active.id, liveChatId };
    }
  }

  // 2. Fallback for API-Key mode: fetch the channel's live stream page to extract the active videoId with 0 search quota
  try {
    const channelUrl = `https://www.youtube.com/channel/${encodeURIComponent(currentYouTubeUser.id)}/live`;
    const htmlRes = await fetch(channelUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const isLiveMatch = html.includes('"isLive":true') || html.includes('"isLiveNow":true');
      const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
      if (isLiveMatch && canonicalMatch?.[1]) {
        const videoId = canonicalMatch[1];
        const vData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('videos', {
          part: 'snippet,liveStreamingDetails',
          id: videoId,
        });
        const vItem = vData?.items?.[0];
        const chatId = vItem?.liveStreamingDetails?.activeLiveChatId || null;
        currentYouTubeUser.liveBroadcastId = videoId;
        currentYouTubeUser.liveChatId = chatId;
        return { broadcastId: videoId, liveChatId: chatId };
      }
    }
  } catch {}

  currentYouTubeUser.liveBroadcastId = null;
  currentYouTubeUser.liveChatId = null;
  return { broadcastId: null, liveChatId: null };
}

/* ──────────────────────────────────────────────────────────
   PROCESS YOUTUBE LIVE CHAT MESSAGES & EVENTS
────────────────────────────────────────────────────────── */
function emitToActiveRooms(event: string, payload: unknown) {
  const io = getIO();
  const rooms = new Set<string>(['global']);
  if (twitchUser?.login) rooms.add(twitchUser.login.toLowerCase());
  if (currentYouTubeUser?.login) {
    rooms.add(currentYouTubeUser.login.toLowerCase());
    rooms.add(currentYouTubeUser.login.replace(/^@/, '').toLowerCase());
  }
  let broadcast = io.to('channel:global');
  for (const r of rooms) {
    broadcast = broadcast.to(`channel:${r}`);
  }
  broadcast.emit(event, payload);
}

function handleYouTubeChatCommand(channelSlug: string, authorName: string, text: string, isSponsor: boolean) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '!sorteo') {
    enterGiveaway(channelSlug, authorName, isSponsor ? 1 : 0);
  }

  checkCustomCommand(channelSlug, authorName, text).then((response) => {
    if (response) {
      sendYouTubeChatMessage(response).catch(() => {});
    }
  });
}

function processYouTubeChatItem(item: YouTubeChatMessageItem, isHistory = false) {
  if (!item.id || processedMessageIds.has(item.id)) return;
  processedMessageIds.add(item.id);
  if (processedMessageIds.size > 500) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }

  const snippet = item.snippet;
  const author = item.authorDetails;
  if (!snippet || !author) return;

  const displayName = author.displayName || 'YouTube Viewer';
  const authorId = author.channelId || item.id;
  const roomSlug = getTargetRoomChannel();
  const badges: string[] = ['youtube'];
  if (author.isChatOwner) badges.push('broadcaster');
  if (author.isChatModerator) badges.push('moderator');
  if (author.isChatSponsor) badges.push('subscriber');
  if (author.isVerified) badges.push('vip');

  const msgType = snippet.type || 'textMessageEvent';

  // 1. Regular Chat Message
  if (msgType === 'textMessageEvent') {
    const text = snippet.textMessageDetails?.messageText || snippet.displayMessage || '';
    if (!text) return;

    if (roomSlug && !isHistory) {
      handleYouTubeChatCommand(roomSlug, displayName, text, Boolean(author.isChatSponsor));
      incrementChatCounter(roomSlug, displayName);
      checkMessage(roomSlug, displayName, text);
    }

    emitToActiveRooms('chat:message', {
      id: item.id,
      platform: 'youtube',
      isHistory,
      user: {
        id: authorId,
        username: displayName.toLowerCase().replace(/\s+/g, '_'),
        displayName,
        color: '#FF0033',
        badges,
      },
      text,
      timestamp: Date.now(),
    });
    return;
  }

  if (isHistory) return;

  // 2. Super Chat / Super Sticker -> channel:cheer + chat:message
  if (msgType === 'superChatEvent' || msgType === 'superStickerEvent') {
    const sc = snippet.superChatDetails || snippet.superStickerDetails;
    const micros = Number(sc?.amountMicros ?? 0);
    const amountUnit = micros > 0 ? micros / 1_000_000 : 5;
    const equivalentBits = Math.max(100, Math.round(amountUnit * 100));
    const formattedAmount = sc?.amountDisplayString || `${amountUnit.toFixed(2)} ${sc?.currency || 'EUR'}`;
    const tierColor = SUPERCHAT_TIER_COLORS[sc?.tier ?? 4] || '#ffb300';
    const comment = snippet.superChatDetails?.userComment || snippet.displayMessage || '';

    emitToActiveRooms('channel:cheer', {
      platform: 'youtube',
      userDisplayName: displayName,
      userName: displayName.toLowerCase(),
      bits: equivalentBits,
      formattedAmount,
      tierColor,
      message: comment,
      timestamp: Date.now(),
    });

    emitToActiveRooms('chat:message', {
      id: item.id,
      platform: 'youtube',
      superChat: { formattedAmount, tierColor },
      user: {
        id: authorId,
        displayName,
        color: '#FFD700',
        badges,
      },
      text: comment || `Super Chat (${formattedAmount})`,
      timestamp: Date.now(),
    });

    if (roomSlug) {
      recordEvent(roomSlug, 'cheer', displayName, `envió Super Chat (${formattedAmount})`, equivalentBits);
      addSubathonTime(roomSlug, {
        id: crypto.randomUUID(),
        type: 'bits',
        user: displayName,
        amount: equivalentBits,
        timeAdded: 0,
        note: `Super Chat ${formattedAmount}`,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // 3. New Channel Member -> channel:subscribe
  if (msgType === 'newSponsorEvent') {
    const levelName = snippet.newSponsorDetails?.memberLevelName || 'Miembro';
    emitToActiveRooms('channel:subscribe', {
      platform: 'youtube',
      userDisplayName: displayName,
      userName: displayName.toLowerCase(),
      tier: '1000',
      isGift: false,
      timestamp: Date.now(),
    });
    if (roomSlug) {
      recordEvent(roomSlug, 'sub', displayName, `se unió como miembro en YouTube (${levelName})`);
      addSubathonTime(roomSlug, {
        id: crypto.randomUUID(),
        type: 'sub',
        user: displayName,
        amount: 1,
        timeAdded: 0,
        tier: '1000',
        note: `Miembro YouTube (${levelName})`,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // 4. Member Milestone -> channel:subscription-message
  if (msgType === 'memberMilestoneChatEvent') {
    const months = snippet.memberMilestoneChatDetails?.memberMonth ?? 1;
    const comment = snippet.memberMilestoneChatDetails?.userComment || '';
    emitToActiveRooms('channel:subscription-message', {
      platform: 'youtube',
      userDisplayName: displayName,
      userName: displayName.toLowerCase(),
      tier: '1000',
      cumulativeMonths: months,
      streakMonths: months,
      messageText: comment,
      timestamp: Date.now(),
    });
    if (roomSlug) {
      recordEvent(roomSlug, 'resub', displayName, `cumplió ${months} mes(es) como miembro en YouTube`);
      addSubathonTime(roomSlug, {
        id: crypto.randomUUID(),
        type: 'sub',
        user: displayName,
        amount: 1,
        timeAdded: 0,
        tier: '1000',
        note: `Miembro ${months} meses`,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // 5. Membership Gifting -> channel:subgift
  if (msgType === 'membershipGiftingEvent') {
    const count = snippet.membershipGiftingDetails?.giftMembershipsCount ?? 1;
    emitToActiveRooms('channel:subgift', {
      platform: 'youtube',
      gifterDisplayName: displayName,
      gifterName: displayName.toLowerCase(),
      tier: '1000',
      amount: count,
      cumulativeAmount: count,
      timestamp: Date.now(),
    });
    if (roomSlug) {
      recordEvent(roomSlug, 'gift', displayName, `regaló ${count} membresía(s) en YouTube`, count);
      for (let i = 0; i < count; i++) {
        addSubathonTime(roomSlug, {
          id: crypto.randomUUID(),
          type: 'sub',
          user: displayName,
          amount: 1,
          timeAdded: 0,
          tier: '1000',
          note: 'Membresía regalada YouTube',
          timestamp: Date.now(),
        });
      }
    }
  }
}

async function pollYouTubeLiveChat() {
  if (!currentYouTubeUser) return;

  const liveChatId = currentYouTubeUser.liveChatId;
  if (!liveChatId) {
    chatPollTimeout = setTimeout(pollYouTubeLiveChat, 15_000);
    return;
  }

  const data = await ytApiFetch<{
    pollingIntervalMillis?: number;
    nextPageToken?: string;
    items?: YouTubeChatMessageItem[];
  }>('liveChat/messages', {
    liveChatId,
    part: 'id,snippet,authorDetails',
    pageToken: nextPageToken || '',
  });

  if (!data) {
    chatPollTimeout = setTimeout(pollYouTubeLiveChat, 12_000);
    return;
  }

  const isFirstPollBatch = !nextPageToken;
  if (data.nextPageToken) {
    nextPageToken = data.nextPageToken;
  }

  if (Array.isArray(data.items)) {
    if (isFirstPollBatch) {
      // Mark older messages as processed, and only emit the last 15 as history so we don't trigger a TTS/alert flood
      const recentSlice = data.items.slice(-15);
      const recentIds = new Set(recentSlice.map((it) => it.id));
      for (const item of data.items) {
        if (!recentIds.has(item.id) && item.id) {
          processedMessageIds.add(item.id);
        }
      }
      for (const item of recentSlice) {
        processYouTubeChatItem(item, true);
      }
    } else {
      for (const item of data.items) {
        processYouTubeChatItem(item, false);
      }
    }
  }

  const waitMs = Math.max(data.pollingIntervalMillis ?? 5000, 3500);
  chatPollTimeout = setTimeout(pollYouTubeLiveChat, waitMs);
}

export async function startYouTubeLiveEngine() {
  stopYouTubeLiveEngine();
  if (!currentYouTubeUser) return;

  logger.info({ user: currentYouTubeUser.displayName, mode: youtubeAuthMode }, '[YouTube] Starting Live Engine');
  await discoverActiveBroadcast();
  pollYouTubeLiveChat();

  // Re-check active broadcast every 60s when not live
  broadcastCheckInterval = setInterval(async () => {
    if (!currentYouTubeUser) return;
    if (!currentYouTubeUser.liveChatId) {
      await discoverActiveBroadcast();
    }
  }, 60_000);
}

export function stopYouTubeLiveEngine() {
  if (chatPollTimeout) {
    clearTimeout(chatPollTimeout);
    chatPollTimeout = null;
  }
  if (broadcastCheckInterval) {
    clearInterval(broadcastCheckInterval);
    broadcastCheckInterval = null;
  }
  nextPageToken = undefined;
}

/* ──────────────────────────────────────────────────────────
   HUD & WRITE OPERATIONS FOR YOUTUBE LIVE
────────────────────────────────────────────────────────── */
export async function fetchYouTubeHud(): Promise<HudData | null> {
  if (!currentYouTubeUser) return null;

  const chData = await ytApiFetch<{ items?: YouTubeChannelItem[] }>('channels', {
    part: 'snippet,statistics',
    id: currentYouTubeUser.id,
  });
  const chItem = chData?.items?.[0];
  const subscribersCount = Number(chItem?.statistics?.subscriberCount ?? 0);

  let viewers = 0;
  let streamTitle = chItem?.snippet?.title || currentYouTubeUser.displayName;
  let startedAt: string | null = null;
  let uptimeSeconds = 0;
  let isLive = false;

  if (!currentYouTubeUser.liveBroadcastId) {
    await discoverActiveBroadcast();
  }

  if (currentYouTubeUser.liveBroadcastId) {
    const vData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('videos', {
      part: 'snippet,liveStreamingDetails',
      id: currentYouTubeUser.liveBroadcastId,
    });
    const vItem = vData?.items?.[0];
    if (vItem?.liveStreamingDetails) {
      isLive = Boolean(vItem.liveStreamingDetails.activeLiveChatId || vItem.liveStreamingDetails.concurrentViewers);
      viewers = Number(vItem.liveStreamingDetails.concurrentViewers ?? 0);
      streamTitle = vItem.snippet?.title || streamTitle;
      startedAt = vItem.liveStreamingDetails.actualStartTime || null;
      if (startedAt) {
        uptimeSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
      }
      if (vItem.liveStreamingDetails.activeLiveChatId) {
        currentYouTubeUser.liveChatId = vItem.liveStreamingDetails.activeLiveChatId;
      }
    }
  }

  return {
    platform: 'youtube',
    viewers,
    followers: subscribersCount,
    subscribers: subscribersCount,
    uptimeSeconds,
    streamTitle,
    gameName: 'YouTube Live',
    startedAt,
    isLive,
    lastFollower: null,
    lastSubscriber: null,
  };
}

export async function sendYouTubeChatMessage(text: string): Promise<boolean> {
  if (!currentYouTubeUser?.liveChatId || youtubeAuthMode !== 'oauth') return false;
  const res = await ytApiFetch('liveChat/messages', { part: 'snippet' }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        liveChatId: currentYouTubeUser.liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: text },
      },
    }),
  });
  return Boolean(res);
}

export async function banYouTubeUser(targetChannelId: string, durationSeconds?: number): Promise<boolean> {
  if (!currentYouTubeUser?.liveChatId || youtubeAuthMode !== 'oauth') return false;
  const res = await ytApiFetch('liveChat/bans', { part: 'snippet' }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        liveChatId: currentYouTubeUser.liveChatId,
        type: durationSeconds ? 'temporary' : 'permanent',
        banDurationSeconds: durationSeconds ? String(durationSeconds) : undefined,
        bannedUserDetails: { channelId: targetChannelId },
      },
    }),
  });
  return Boolean(res);
}

/* ──────────────────────────────────────────────────────────
   SESSION RESTORE & FASTIFY ROUTES
────────────────────────────────────────────────────────── */
async function restoreYouTubeSession() {
  storedData = loadStoredYouTubeData();
  const sess = storedData.session;
  if (!sess) return;

  youtubeAuthMode = sess.authMode;
  currentYouTubeUser = {
    platform: 'youtube',
    id: sess.channelId,
    channelId: sess.channelId,
    login: sess.login,
    displayName: sess.displayName,
    avatarUrl: sess.avatarUrl,
    profileImageUrl: sess.avatarUrl ?? undefined,
    liveBroadcastId: sess.liveBroadcastId ?? null,
    liveChatId: sess.liveChatId ?? null,
  };

  await ensurePrismaUserForYouTube(currentYouTubeUser);
  startYouTubeLiveEngine().catch(() => {});
  logger.info({ user: currentYouTubeUser.displayName, mode: youtubeAuthMode }, '[YouTube] Session restored');
}

export async function setupYouTube(app: FastifyInstance) {
  await restoreYouTubeSession();

  // 1. Get YouTube credentials status
  app.get('/youtube/credentials', async () => {
    return getYouTubeCredentialsInfo();
  });

  // 2. Save YouTube credentials (Client ID, Client Secret, API Key) encrypted with AES-256-GCM
  app.put('/youtube/credentials', async (req, reply) => {
    const parsed = YouTubeCredentialsSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid credentials payload' });
    }
    const { clientId, clientSecret, apiKey } = parsed.data;
    if (clientId !== undefined) storedData.clientId = clientId;
    if (clientSecret !== undefined && clientSecret !== '') {
      storedData.clientSecretEnc = encryptToken(clientSecret);
    }
    if (apiKey !== undefined && apiKey !== '') {
      storedData.apiKeyEnc = encryptToken(apiKey);
    }
    saveStoredYouTubeData();
    return {
      ok: true,
      credentials: getYouTubeCredentialsInfo(),
    };
  });

  // 3. Get YouTube connection status
  app.get('/youtube/status', async () => {
    return {
      authenticated: currentYouTubeUser !== null,
      authMode: youtubeAuthMode,
      user: currentYouTubeUser,
      credentials: getYouTubeCredentialsInfo(),
    };
  });

  // 4. Start Google OAuth 2.0 Authorization Flow
  app.post('/auth/youtube/start', async (_req, reply) => {
    const clientId = getEffectiveClientId();
    const clientSecret = getEffectiveClientSecret();
    if (!clientId || !clientSecret) {
      return reply.status(400).send({
        error: 'missing_credentials',
        message: 'Introduce tu Google Client ID y Client Secret antes de iniciar el login OAuth.',
      });
    }

    const redirectUri = getRedirectUri();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', YT_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return reply.send({ authUrl: authUrl.toString(), redirectUri });
  });

  // 5. Google OAuth 2.0 Callback
  app.get('/auth/youtube/callback', async (req, reply) => {
    const query = req.query as { code?: string; error?: string };
    if (query.error || !query.code) {
      return reply.type('text/html; charset=utf-8').send(`
        <!DOCTYPE html><html><body style="background:#0a0e1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;padding:32px;border:1px solid #ef4444;border-radius:12px">
            <h2>❌ Error al conectar YouTube</h2>
            <p>${query.error || 'No se recibió código de autorización.'}</p>
          </div>
        </body></html>
      `);
    }

    const clientId = getEffectiveClientId();
    const clientSecret = getEffectiveClientSecret();
    const redirectUri = getRedirectUri();

    const params = new URLSearchParams({
      code: query.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      logger.error({ errText }, '[YouTube] OAuth token exchange failed');
      return reply.status(400).type('text/html; charset=utf-8').send(`
        <!DOCTYPE html><html><body style="background:#0a0e1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;padding:32px;border:1px solid #ef4444;border-radius:12px">
            <h2>❌ Falló el intercambio de token con Google</h2>
            <p>Verifica que el Client Secret y el Redirect URI (${redirectUri}) sean correctos.</p>
          </div>
        </body></html>
      `);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Fetch the authenticated user's YouTube channel
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const chBody = (await chRes.json().catch(() => ({}))) as { items?: YouTubeChannelItem[] };
    const ch = chBody.items?.[0];

    if (!ch) {
      return reply.status(404).type('text/html; charset=utf-8').send(`
        <!DOCTYPE html><html><body style="background:#0a0e1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;padding:32px;border:1px solid #ef4444;border-radius:12px">
            <h2>❌ No se encontró canal de YouTube en esta cuenta</h2>
            <p>Asegúrate de seleccionar la cuenta de marca/canal de YouTube correcta al autorizar.</p>
          </div>
        </body></html>
      `);
    }

    const login = normalizeHandleToLogin(ch.snippet?.customUrl, ch.snippet?.title, ch.id);
    const displayName = ch.snippet?.title || login;
    const avatarUrl = ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null;

    storedData.session = {
      authMode: 'oauth',
      channelId: ch.id,
      login,
      displayName,
      avatarUrl,
      accessTokenEnc: encryptToken(tokenData.access_token),
      refreshTokenEnc: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : storedData.session?.refreshTokenEnc,
      tokenExpiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    };
    saveStoredYouTubeData();

    youtubeAuthMode = 'oauth';
    currentYouTubeUser = {
      platform: 'youtube',
      id: ch.id,
      channelId: ch.id,
      login,
      displayName,
      avatarUrl,
      profileImageUrl: avatarUrl ?? undefined,
    };

    await ensurePrismaUserForYouTube(currentYouTubeUser);
    startYouTubeLiveEngine().catch(() => {});
    try { getIO().emit('auth:changed'); } catch {}

    return reply.type('text/html; charset=utf-8').send(`
      <!DOCTYPE html>
      <html>
      <head><title>StreamDaemon · YouTube Conectado</title></head>
      <body style="background:#0a0e1a;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;padding:36px 44px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,0,51,0.45);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,0.6)">
          <div style="font-size:46px;margin-bottom:12px">✅</div>
          <h2 style="margin:0 0 8px;color:#ff4d6d">¡YouTube Live Conectado!</h2>
          <p style="margin:0 0 16px;color:#cbd5e1">Canal: <strong>${displayName}</strong> (@${login})</p>
          <p style="margin:0;font-size:13px;color:#94a3b8">Ya puedes cerrar esta ventana y volver a StreamDaemon.</p>
          <script>setTimeout(() => window.close(), 1800);</script>
        </div>
      </body>
      </html>
    `);
  });

  // 6. Quick Connect via Channel @handle or Channel ID + API Key
  app.post('/auth/youtube/quick-connect', async (req, reply) => {
    const parsed = YouTubeQuickConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Introduce un @handle o ID de canal válido.' });
    }

    const { channelHandleOrId, apiKey } = parsed.data;
    if (apiKey && apiKey.trim()) {
      storedData.apiKeyEnc = encryptToken(apiKey.trim());
      saveStoredYouTubeData();
    }

    const effectiveKey = getEffectiveApiKey();
    if (!effectiveKey) {
      return reply.status(400).send({
        error: 'missing_api_key',
        message: 'Introduce tu YouTube Data API v3 Key para conectar el canal.',
      });
    }

    const cleanInput = channelHandleOrId.trim();
    const isChannelId = /^UC[a-zA-Z0-9_-]{20,}$/.test(cleanInput);
    const handleParam = cleanInput.startsWith('@') ? cleanInput : `@${cleanInput}`;

    const lookupUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    lookupUrl.searchParams.set('part', 'snippet,statistics');
    if (isChannelId) {
      lookupUrl.searchParams.set('id', cleanInput);
    } else {
      lookupUrl.searchParams.set('forHandle', handleParam);
    }
    lookupUrl.searchParams.set('key', effectiveKey);

    const res = await fetch(lookupUrl.toString());
    if (!res.ok) {
      return reply.status(400).send({
        error: 'api_error',
        message: 'No se pudo verificar con YouTube API. Revisa que tu API Key sea válida y tenga habilitada "YouTube Data API v3".',
      });
    }

    const body = (await res.json()) as { items?: YouTubeChannelItem[] };
    const ch = body.items?.[0];
    if (!ch) {
      return reply.status(404).send({
        error: 'channel_not_found',
        message: `No se encontró ningún canal de YouTube para "${cleanInput}". Prueba con tu @handle o tu ID de canal (UC...).`,
      });
    }

    const login = normalizeHandleToLogin(ch.snippet?.customUrl, ch.snippet?.title, ch.id);
    const displayName = ch.snippet?.title || login;
    const avatarUrl = ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null;

    storedData.session = {
      authMode: 'apikey',
      channelId: ch.id,
      login,
      displayName,
      avatarUrl,
    };
    saveStoredYouTubeData();

    youtubeAuthMode = 'apikey';
    currentYouTubeUser = {
      platform: 'youtube',
      id: ch.id,
      channelId: ch.id,
      login,
      displayName,
      avatarUrl,
      profileImageUrl: avatarUrl ?? undefined,
    };

    await ensurePrismaUserForYouTube(currentYouTubeUser);
    startYouTubeLiveEngine().catch(() => {});
    try { getIO().emit('auth:changed'); } catch {}

    return reply.send({
      status: 'authenticated',
      authMode: 'apikey',
      user: currentYouTubeUser,
    });
  });

  // 7. Disconnect YouTube
  app.post('/auth/youtube/logout', async (_req, reply) => {
    stopYouTubeLiveEngine();
    currentYouTubeUser = null;
    youtubeAuthMode = null;
    storedData.session = null;
    saveStoredYouTubeData();
    try { getIO().emit('auth:changed'); } catch {}
    return reply.send({ success: true });
  });

  // 8. Simulate YouTube Live Events (Chat, Subscriber, Member, Milestone, Gift, SuperChat)
  app.post('/youtube/simulate-event', async (req, reply) => {
    const parsed = YouTubeSimulateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid simulation payload' });
    }
    const { channel, type, user, message, amount = 5, currency = 'EUR', months = 6 } = parsed.data;
    const targetRoom = getTargetRoomChannel(channel);
    const io = getIO();

    if (type === 'subscriber') {
      const payload = {
        platform: 'youtube' as const,
        userDisplayName: user,
        userName: user.toLowerCase(),
        userId: `yt-sim-${Date.now()}`,
        timestamp: Date.now(),
      };
      io.to(`channel:${targetRoom}`).emit('channel:follow', payload);
      recordEvent(targetRoom, 'follow', user, 'se suscribió al canal de YouTube');
      return reply.send({ ok: true, event: 'channel:follow', payload });
    }

    if (type === 'chat') {
      processYouTubeChatItem({
        id: `yt-sim-chat-${Date.now()}`,
        snippet: {
          type: 'textMessageEvent',
          textMessageDetails: { messageText: message || '¡Saludos desde el directo de YouTube! 🔴🔥' },
        },
        authorDetails: {
          channelId: `yt-user-${Date.now()}`,
          displayName: user,
          isChatSponsor: true,
        },
      });
      return reply.send({ ok: true, event: 'chat:message' });
    }

    if (type === 'superchat') {
      processYouTubeChatItem({
        id: `yt-sim-sc-${Date.now()}`,
        snippet: {
          type: 'superChatEvent',
          superChatDetails: {
            amountMicros: String(Math.round(amount * 1_000_000)),
            currency,
            amountDisplayString: `${amount.toFixed(2)} ${currency}`,
            userComment: message || '¡Grande el directo en YouTube! Toma un Super Chat 💎',
            tier: amount >= 50 ? 6 : amount >= 20 ? 5 : amount >= 10 ? 4 : 3,
          },
        },
        authorDetails: {
          channelId: `yt-user-${Date.now()}`,
          displayName: user,
          isChatSponsor: true,
        },
      });
      return reply.send({ ok: true, event: 'channel:cheer' });
    }

    if (type === 'member') {
      processYouTubeChatItem({
        id: `yt-sim-mem-${Date.now()}`,
        snippet: {
          type: 'newSponsorEvent',
          newSponsorDetails: { memberLevelName: 'Nivel VIP' },
        },
        authorDetails: {
          channelId: `yt-user-${Date.now()}`,
          displayName: user,
          isChatSponsor: true,
        },
      });
      return reply.send({ ok: true, event: 'channel:subscribe' });
    }

    if (type === 'milestone') {
      processYouTubeChatItem({
        id: `yt-sim-ms-${Date.now()}`,
        snippet: {
          type: 'memberMilestoneChatEvent',
          memberMilestoneChatDetails: {
            memberLevelName: 'Nivel VIP',
            memberMonth: months,
            userComment: message || `¡${months} meses apoyando el canal en YouTube!`,
          },
        },
        authorDetails: {
          channelId: `yt-user-${Date.now()}`,
          displayName: user,
          isChatSponsor: true,
        },
      });
      return reply.send({ ok: true, event: 'channel:subscription-message' });
    }

    if (type === 'gift') {
      processYouTubeChatItem({
        id: `yt-sim-gift-${Date.now()}`,
        snippet: {
          type: 'membershipGiftingEvent',
          membershipGiftingDetails: {
            giftMembershipsCount: Math.max(1, Math.round(amount)),
            giftMembershipsLevelName: 'Miembro',
          },
        },
        authorDetails: {
          channelId: `yt-user-${Date.now()}`,
          displayName: user,
          isChatSponsor: true,
        },
      });
      return reply.send({ ok: true, event: 'channel:subgift' });
    }

    return reply.send({ ok: true });
  });
}

