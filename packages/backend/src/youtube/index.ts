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
  type YouTubeBroadcastInfo,
  type KpiVideoArchiveItem,
  type TwitchTopGame,
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

export const YOUTUBE_CATEGORIES: Array<{ id: string; name: string }> = [
  { id: '20', name: 'Videojuegos (Gaming)' },
  { id: '24', name: 'Entretenimiento' },
  { id: '22', name: 'Personas y blogs' },
  { id: '10', name: 'Música' },
  { id: '28', name: 'Ciencia y tecnología' },
  { id: '17', name: 'Deportes' },
  { id: '23', name: 'Comedia' },
  { id: '27', name: 'Educación' },
  { id: '25', name: 'Noticias y política' },
  { id: '26', name: 'Consejos y estilo' },
  { id: '1', name: 'Cine y animación' },
  { id: '2', name: 'Motor y vehículos' },
];

export function getYouTubeCategoryName(categoryId?: string): string {
  if (!categoryId) return 'Videojuegos (Gaming)';
  return YOUTUBE_CATEGORIES.find((c) => c.id === categoryId)?.name || 'YouTube Live';
}

interface StoredYouTubeData {
  clientId?: string;
  clientSecretEnc?: string;
  apiKeyEnc?: string;
  broadcastDraft?: {
    title?: string;
    description?: string;
    categoryId?: string;
    tags?: string[];
    privacyStatus?: 'public' | 'unlisted' | 'private';
  };
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
    description?: string;
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
    description?: string;
    tags?: string[];
    liveChatId?: string;
    actualStartTime?: string;
    publishedAt?: string;
    categoryId?: string;
  };
  status?: {
    privacyStatus?: 'public' | 'unlisted' | 'private';
    lifeCycleStatus?: string;
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
async function discoverActiveBroadcast(manualVideoId?: string): Promise<{ broadcastId: string | null; liveChatId: string | null }> {
  if (!currentYouTubeUser) return { broadcastId: null, liveChatId: null };

  // 0. If a manual video ID was provided, verify it directly via videos.list (costs 1 unit)
  if (manualVideoId) {
    const cleanId = extractYouTubeVideoId(manualVideoId);
    if (cleanId) {
      const vData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('videos', {
        part: 'snippet,status,liveStreamingDetails',
        id: cleanId,
      });
      const vItem = vData?.items?.[0];
      if (vItem) {
        const chatId = vItem.liveStreamingDetails?.activeLiveChatId || vItem.snippet?.liveChatId || null;
        currentYouTubeUser.liveBroadcastId = vItem.id;
        currentYouTubeUser.liveChatId = chatId;
        if (storedData.session) {
          storedData.session.liveBroadcastId = vItem.id;
          storedData.session.liveChatId = chatId;
          saveStoredYouTubeData();
        }
        return { broadcastId: vItem.id, liveChatId: chatId };
      }
    }
  }

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

    // Check upcoming broadcast if not currently live so the streamer can pre-configure title/tags/category
    const upcomingData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('liveBroadcasts', {
      part: 'snippet,status,contentDetails',
      broadcastStatus: 'upcoming',
      maxResults: '1',
    });
    const upcoming = upcomingData?.items?.[0];
    if (upcoming) {
      const liveChatId = upcoming.snippet?.liveChatId || null;
      currentYouTubeUser.liveBroadcastId = upcoming.id;
      currentYouTubeUser.liveChatId = liveChatId;
      return { broadcastId: upcoming.id, liveChatId };
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
          part: 'snippet,status,liveStreamingDetails',
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

  // Preserve manually linked broadcastId if still valid in session
  if (storedData.session?.liveBroadcastId) {
    currentYouTubeUser.liveBroadcastId = storedData.session.liveBroadcastId;
    currentYouTubeUser.liveChatId = storedData.session.liveChatId || null;
    return {
      broadcastId: currentYouTubeUser.liveBroadcastId,
      liveChatId: currentYouTubeUser.liveChatId,
    };
  }

  currentYouTubeUser.liveBroadcastId = null;
  currentYouTubeUser.liveChatId = null;
  return { broadcastId: null, liveChatId: null };
}

function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    const v = u.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /^[a-zA-Z0-9_-]{11}$/.test(last)) return last;
  } catch {}
  return null;
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
      incrementChatCounter(roomSlug, displayName, 'youtube');
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
      recordEvent(roomSlug, 'cheer', displayName, `envió Super Chat (${formattedAmount})${comment ? `: "${comment}"` : ''}`, equivalentBits, 'youtube', formattedAmount);
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
      recordEvent(roomSlug, 'sub', displayName, `se unió como miembro en YouTube (${levelName})`, undefined, 'youtube');
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
      recordEvent(roomSlug, 'resub', displayName, `cumplió ${months} mes(es) como miembro en YouTube`, undefined, 'youtube');
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
      recordEvent(roomSlug, 'gift', displayName, `regaló ${count} membresía(s) en YouTube`, count, 'youtube');
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
  let streamTitle = storedData.broadcastDraft?.title || chItem?.snippet?.title || currentYouTubeUser.displayName;
  let description = storedData.broadcastDraft?.description || chItem?.snippet?.description || '';
  let categoryId = storedData.broadcastDraft?.categoryId || '20';
  let tags = storedData.broadcastDraft?.tags || [];
  let privacyStatus: 'public' | 'unlisted' | 'private' = storedData.broadcastDraft?.privacyStatus || 'public';
  let startedAt: string | null = null;
  let uptimeSeconds = 0;
  let isLive = false;

  if (!currentYouTubeUser.liveBroadcastId) {
    await discoverActiveBroadcast();
  }

  if (currentYouTubeUser.liveBroadcastId) {
    const vData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('videos', {
      part: 'snippet,status,liveStreamingDetails',
      id: currentYouTubeUser.liveBroadcastId,
    });
    const vItem = vData?.items?.[0];
    if (vItem) {
      streamTitle = vItem.snippet?.title || streamTitle;
      description = vItem.snippet?.description ?? description;
      categoryId = vItem.snippet?.categoryId || categoryId;
      tags = Array.isArray(vItem.snippet?.tags) ? vItem.snippet!.tags! : tags;
      privacyStatus = vItem.status?.privacyStatus || privacyStatus;
      if (vItem.liveStreamingDetails) {
        isLive = Boolean(vItem.liveStreamingDetails.activeLiveChatId || vItem.liveStreamingDetails.concurrentViewers);
        viewers = Number(vItem.liveStreamingDetails.concurrentViewers ?? 0);
        startedAt = vItem.liveStreamingDetails.actualStartTime || null;
        if (startedAt) {
          uptimeSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
        }
        if (vItem.liveStreamingDetails.activeLiveChatId) {
          currentYouTubeUser.liveChatId = vItem.liveStreamingDetails.activeLiveChatId;
        }
      }
    }
  }

  const categoryName = getYouTubeCategoryName(categoryId);

  return {
    platform: 'youtube',
    platformBreakdown: {
      youtube: {
        viewers,
        subscribers: subscribersCount,
        members: 0,
        uptimeSeconds,
        streamTitle,
        description,
        categoryId,
        categoryName,
        tags,
        privacyStatus,
        startedAt,
        liveBroadcastId: currentYouTubeUser.liveBroadcastId || null,
        channelId: currentYouTubeUser.id,
        login: currentYouTubeUser.login,
        displayName: currentYouTubeUser.displayName,
        authMode: youtubeAuthMode,
        isLive,
      },
    },
    viewers,
    followers: subscribersCount,
    subscribers: subscribersCount,
    uptimeSeconds,
    streamTitle,
    gameName: categoryName,
    startedAt,
    isLive,
    lastFollower: null,
    lastSubscriber: null,
  };
}

export async function getYouTubeBroadcastInfo(): Promise<YouTubeBroadcastInfo> {
  if (!currentYouTubeUser) {
    return {
      connected: false,
      authMode: null,
      canEdit: false,
      liveBroadcastId: null,
      isLive: false,
      title: storedData.broadcastDraft?.title || '',
      description: storedData.broadcastDraft?.description || '',
      categoryId: storedData.broadcastDraft?.categoryId || '20',
      categoryName: getYouTubeCategoryName(storedData.broadcastDraft?.categoryId || '20'),
      tags: storedData.broadcastDraft?.tags || [],
      privacyStatus: storedData.broadcastDraft?.privacyStatus || 'public',
      categories: YOUTUBE_CATEGORIES,
    };
  }

  const hud = await fetchYouTubeHud();
  const yt = hud?.platformBreakdown?.youtube;
  const categoryId = yt?.categoryId || storedData.broadcastDraft?.categoryId || '20';

  return {
    connected: true,
    authMode: youtubeAuthMode,
    canEdit: youtubeAuthMode === 'oauth',
    channelId: currentYouTubeUser.id,
    login: currentYouTubeUser.login,
    displayName: currentYouTubeUser.displayName,
    liveBroadcastId: currentYouTubeUser.liveBroadcastId || null,
    isLive: Boolean(yt?.isLive),
    title: yt?.streamTitle || storedData.broadcastDraft?.title || currentYouTubeUser.displayName,
    description: yt?.description ?? storedData.broadcastDraft?.description ?? '',
    categoryId,
    categoryName: getYouTubeCategoryName(categoryId),
    tags: yt?.tags || storedData.broadcastDraft?.tags || [],
    privacyStatus: yt?.privacyStatus || storedData.broadcastDraft?.privacyStatus || 'public',
    categories: YOUTUBE_CATEGORIES,
  };
}

export async function updateYouTubeBroadcastInfo(payload: {
  title?: string;
  description?: string;
  categoryId?: string;
  tags?: string[];
  privacyStatus?: 'public' | 'unlisted' | 'private';
}): Promise<{ ok: boolean; syncedToYouTubeApi: boolean; broadcastId: string | null; message: string }> {
  // Always persist in local broadcastDraft so metadata survives restarts and updates HUD immediately
  storedData.broadcastDraft = {
    title: payload.title !== undefined ? payload.title.slice(0, 100) : storedData.broadcastDraft?.title,
    description: payload.description !== undefined ? payload.description.slice(0, 5000) : storedData.broadcastDraft?.description,
    categoryId: payload.categoryId || storedData.broadcastDraft?.categoryId || '20',
    tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 15) : storedData.broadcastDraft?.tags || [],
    privacyStatus: payload.privacyStatus || storedData.broadcastDraft?.privacyStatus || 'public',
  };
  saveStoredYouTubeData();

  if (!currentYouTubeUser) {
    return {
      ok: true,
      syncedToYouTubeApi: false,
      broadcastId: null,
      message: 'Borrador guardado localmente (conecta YouTube para sincronizar con tu canal).',
    };
  }

  if (youtubeAuthMode !== 'oauth') {
    return {
      ok: true,
      syncedToYouTubeApi: false,
      broadcastId: currentYouTubeUser.liveBroadcastId || null,
      message: 'Guardado en StreamDaemon. Para modificar el directo en YouTube Studio automáticamente, inicia sesión con OAuth 2.0.',
    };
  }

  if (!currentYouTubeUser.liveBroadcastId) {
    await discoverActiveBroadcast();
  }

  const videoId = currentYouTubeUser.liveBroadcastId;
  if (!videoId) {
    return {
      ok: true,
      syncedToYouTubeApi: false,
      broadcastId: null,
      message: 'Plantilla de emisión guardada. Se aplicará en cuanto inicies o programes una emisión en YouTube Live.',
    };
  }

  // Fetch existing snippet & status so we don't accidentally wipe fields not passed
  const vData = await ytApiFetch<{ items?: YouTubeBroadcastItem[] }>('videos', {
    part: 'snippet,status',
    id: videoId,
  });
  const currentVideo = vData?.items?.[0];

  const nextTitle = (payload.title ?? currentVideo?.snippet?.title ?? currentYouTubeUser.displayName).slice(0, 100);
  const nextDescription = payload.description ?? currentVideo?.snippet?.description ?? '';
  const nextCategoryId = payload.categoryId || currentVideo?.snippet?.categoryId || '20';
  const nextTags = payload.tags ?? currentVideo?.snippet?.tags ?? [];
  const nextPrivacy = payload.privacyStatus || currentVideo?.status?.privacyStatus || 'public';

  const updated = await ytApiFetch<YouTubeBroadcastItem>(
    'videos',
    { part: 'snippet,status' },
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: videoId,
        snippet: {
          title: nextTitle,
          description: nextDescription,
          categoryId: nextCategoryId,
          tags: nextTags,
        },
        status: {
          privacyStatus: nextPrivacy,
        },
      }),
    },
  );

  if (updated) {
    return {
      ok: true,
      syncedToYouTubeApi: true,
      broadcastId: videoId,
      message: 'Metadatos de YouTube Live actualizados en tiempo real.',
    };
  }

  return {
    ok: true,
    syncedToYouTubeApi: false,
    broadcastId: videoId,
    message: 'Guardado en StreamDaemon (YouTube API rechazó la escritura o la emisión ha finalizado).',
  };
}

function parseIsoDurationSeconds(iso?: string): number {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = Number(match[1] || 0);
  const m = Number(match[2] || 0);
  const s = Number(match[3] || 0);
  return h * 3600 + m * 60 + s;
}

export interface YouTubeAnalyticsSnapshot {
  channelId: string;
  login: string;
  displayName: string;
  subscribers: number;
  totalChannelViews: number;
  videoCount: number;
  isLive: boolean;
  archives: KpiVideoArchiveItem[];
}

let ytAnalyticsCache: { data: YouTubeAnalyticsSnapshot; fetchedAt: number } | null = null;
let ytTopGamingCache: { data: TwitchTopGame[]; fetchedAt: number } | null = null;

export async function fetchYouTubeChannelAnalytics(forceRefresh = false): Promise<YouTubeAnalyticsSnapshot | null> {
  if (!currentYouTubeUser) return null;
  if (!forceRefresh && ytAnalyticsCache && Date.now() - ytAnalyticsCache.fetchedAt < 300_000) {
    return ytAnalyticsCache.data;
  }

  const chData = await ytApiFetch<{
    items?: Array<{
      id: string;
      snippet?: { title?: string; customUrl?: string };
      statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  }>('channels', {
    part: 'snippet,statistics,contentDetails',
    id: currentYouTubeUser.id,
  });

  const ch = chData?.items?.[0];
  const subscribers = Number(ch?.statistics?.subscriberCount ?? 0);
  const totalChannelViews = Number(ch?.statistics?.viewCount ?? 0);
  const videoCount = Number(ch?.statistics?.videoCount ?? 0);
  const uploadsPlaylistId = ch?.contentDetails?.relatedPlaylists?.uploads;

  const archives: KpiVideoArchiveItem[] = [];

  if (uploadsPlaylistId) {
    const plData = await ytApiFetch<{
      items?: Array<{ contentDetails?: { videoId?: string } }>;
    }>('playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: '40',
    });

    const videoIds = (plData?.items || [])
      .map((it) => it.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));

    if (videoIds.length > 0) {
      const vData = await ytApiFetch<{
        items?: Array<{
          id: string;
          snippet?: {
            title?: string;
            publishedAt?: string;
            categoryId?: string;
            thumbnails?: {
              medium?: { url?: string };
              high?: { url?: string };
              default?: { url?: string };
            };
          };
          contentDetails?: { duration?: string };
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
          liveStreamingDetails?: {
            actualStartTime?: string;
            actualEndTime?: string;
            concurrentViewers?: string;
            activeLiveChatId?: string;
          };
        }>;
      }>('videos', {
        part: 'snippet,contentDetails,statistics,liveStreamingDetails',
        id: videoIds.join(','),
      });

      for (const v of vData?.items || []) {
        let durationSeconds = parseIsoDurationSeconds(v.contentDetails?.duration);
        if (
          durationSeconds === 0 &&
          v.liveStreamingDetails?.actualStartTime &&
          v.liveStreamingDetails?.actualEndTime
        ) {
          const diff =
            new Date(v.liveStreamingDetails.actualEndTime).getTime() -
            new Date(v.liveStreamingDetails.actualStartTime).getTime();
          if (diff > 0) durationSeconds = Math.floor(diff / 1000);
        }

        const views = Number(v.statistics?.viewCount ?? 0);
        const likes = Number(v.statistics?.likeCount ?? 0);
        const comments = Number(v.statistics?.commentCount ?? 0);
        const concurrent = Number(v.liveStreamingDetails?.concurrentViewers ?? 0);
        const catId = v.snippet?.categoryId || '20';

        archives.push({
          id: v.id,
          platform: 'youtube',
          title: v.snippet?.title || 'Vídeo / Emisión de YouTube',
          categoryName: getYouTubeCategoryName(catId),
          publishedAt:
            v.liveStreamingDetails?.actualStartTime ||
            v.snippet?.publishedAt ||
            new Date().toISOString(),
          durationSeconds,
          views,
          likes,
          comments,
          peakConcurrentViewers: Math.max(concurrent, views),
          thumbnailUrl:
            v.snippet?.thumbnails?.medium?.url ||
            v.snippet?.thumbnails?.high?.url ||
            v.snippet?.thumbnails?.default?.url,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          isLiveArchive: Boolean(
            v.liveStreamingDetails?.actualStartTime || v.liveStreamingDetails?.activeLiveChatId,
          ),
        });
      }
    }
  }

  const snapshot: YouTubeAnalyticsSnapshot = {
    channelId: currentYouTubeUser.id,
    login: currentYouTubeUser.login,
    displayName: currentYouTubeUser.displayName,
    subscribers,
    totalChannelViews,
    videoCount,
    isLive: Boolean(currentYouTubeUser.liveBroadcastId),
    archives,
  };

  ytAnalyticsCache = { data: snapshot, fetchedAt: Date.now() };
  return snapshot;
}

export async function fetchYouTubeTopGamingTrends(): Promise<TwitchTopGame[]> {
  if (ytTopGamingCache && Date.now() - ytTopGamingCache.fetchedAt < 900_000) {
    return ytTopGamingCache.data;
  }

  const vData = await ytApiFetch<{
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        channelTitle?: string;
        thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
      };
      statistics?: { viewCount?: string };
    }>;
  }>('videos', {
    part: 'snippet,statistics',
    chart: 'mostPopular',
    videoCategoryId: '20',
    maxResults: '12',
  });

  if (!vData?.items?.length) return [];

  const list: TwitchTopGame[] = vData.items.map((item) => ({
    id: `yt-${item.id}`,
    platform: 'youtube',
    name: item.snippet?.title || 'Tendencia Gaming YouTube',
    topChannelName: item.snippet?.channelTitle || 'YouTube Gaming',
    boxArtUrl:
      item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.high?.url || '',
    estimatedViewers: Number(item.statistics?.viewCount ?? 0),
  }));

  ytTopGamingCache = { data: list, fetchedAt: Date.now() };
  return list;
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

    if (type === 'subscriber') {
      const payload = {
        platform: 'youtube' as const,
        userDisplayName: user,
        userName: user.toLowerCase(),
        userId: `yt-sim-${Date.now()}`,
        timestamp: Date.now(),
      };
      emitToActiveRooms('channel:follow', payload);
      recordEvent(targetRoom, 'follow', user, 'se suscribió al canal de YouTube', undefined, 'youtube');
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

  // 9. Get YouTube Live Broadcast Metadata & Categories
  app.get('/youtube/broadcast/info', async (_req, reply) => {
    const info = await getYouTubeBroadcastInfo();
    return reply.send(info);
  });

  // 10. Update YouTube Live Broadcast Metadata (Title, Description, Category, Tags, Privacy)
  app.put('/youtube/broadcast/info', async (req, reply) => {
    const body = (req.body || {}) as {
      title?: string;
      description?: string;
      categoryId?: string;
      tags?: string[];
      privacyStatus?: 'public' | 'unlisted' | 'private';
    };
    const result = await updateYouTubeBroadcastInfo(body);
    return reply.send(result);
  });

  // 11. Detect or manually link a YouTube Live Broadcast ID / URL
  app.post('/youtube/broadcast/detect', async (req, reply) => {
    const body = (req.body || {}) as { videoIdOrUrl?: string };
    if (body.videoIdOrUrl === '') {
      // Clear manual override and re-discover
      if (storedData.session) {
        storedData.session.liveBroadcastId = null;
        storedData.session.liveChatId = null;
        saveStoredYouTubeData();
      }
      if (currentYouTubeUser) {
        currentYouTubeUser.liveBroadcastId = null;
        currentYouTubeUser.liveChatId = null;
      }
    }
    const found = await discoverActiveBroadcast(body.videoIdOrUrl?.trim() || undefined);
    const info = await getYouTubeBroadcastInfo();
    return reply.send({
      ok: Boolean(found.broadcastId),
      broadcastId: found.broadcastId,
      liveChatId: found.liveChatId,
      info,
    });
  });

  // 12. Simulate Twitch or YouTube Activity Events for testing Gestor de Stream & Overlays
  app.post('/activity/simulate', async (req, reply) => {
    const body = (req.body || {}) as {
      platform?: 'twitch' | 'youtube';
      type?: 'follow' | 'sub' | 'resub' | 'gift' | 'cheer' | 'raid' | 'redemption';
      user?: string;
      channel?: string;
    };
    const platform = body.platform === 'youtube' ? 'youtube' : 'twitch';
    const type = body.type || 'follow';
    const user = body.user?.trim() || (platform === 'youtube' ? 'CyberViewer_YT' : 'NeonRunner_TW');
    const targetRoom = getTargetRoomChannel(body.channel);

    if (platform === 'youtube') {
      if (type === 'follow') {
        const payload = {
          platform: 'youtube' as const,
          userDisplayName: user,
          userName: user.toLowerCase(),
          userId: `yt-sim-${Date.now()}`,
          timestamp: Date.now(),
        };
        emitToActiveRooms('channel:follow', payload);
        recordEvent(targetRoom, 'follow', user, 'se suscribió al canal de YouTube', undefined, 'youtube');
      } else if (type === 'sub') {
        emitToActiveRooms('channel:subscribe', {
          platform: 'youtube',
          userDisplayName: user,
          userName: user.toLowerCase(),
          tier: '1000',
          isGift: false,
          timestamp: Date.now(),
        });
        recordEvent(targetRoom, 'sub', user, 'se unió como miembro en YouTube (Nivel VIP)', undefined, 'youtube');
      } else if (type === 'resub') {
        emitToActiveRooms('channel:subscription-message', {
          platform: 'youtube',
          userDisplayName: user,
          userName: user.toLowerCase(),
          tier: '1000',
          cumulativeMonths: 6,
          streakMonths: 6,
          messageText: '¡6 meses apoyando en YouTube Live!',
          timestamp: Date.now(),
        });
        recordEvent(targetRoom, 'resub', user, 'cumplió 6 meses como miembro en YouTube', undefined, 'youtube');
      } else if (type === 'gift') {
        emitToActiveRooms('channel:subgift', {
          platform: 'youtube',
          gifterDisplayName: user,
          gifterName: user.toLowerCase(),
          tier: '1000',
          amount: 5,
          cumulativeAmount: 5,
          timestamp: Date.now(),
        });
        recordEvent(targetRoom, 'gift', user, 'regaló 5 membresías en YouTube', 5, 'youtube');
      } else if (type === 'cheer') {
        emitToActiveRooms('channel:cheer', {
          platform: 'youtube',
          userDisplayName: user,
          userName: user.toLowerCase(),
          bits: 1000,
          formattedAmount: '10,00 €',
          tierColor: '#E65100',
          message: '¡Gran directo en YouTube! Toma un Super Chat 🔥',
          timestamp: Date.now(),
        });
        recordEvent(targetRoom, 'cheer', user, 'envió Super Chat (10,00 €): "¡Gran directo en YouTube!"', 1000, 'youtube', '10,00 €');
      }
      return reply.send({ ok: true, platform, type });
    }

    // Twitch simulation
    if (type === 'follow') {
      emitToActiveRooms('channel:follow', {
        platform: 'twitch',
        userDisplayName: user,
        userName: user.toLowerCase(),
        userId: `tw-sim-${Date.now()}`,
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'follow', user, 'siguió el canal', undefined, 'twitch');
    } else if (type === 'sub') {
      emitToActiveRooms('channel:subscribe', {
        platform: 'twitch',
        userDisplayName: user,
        userName: user.toLowerCase(),
        tier: '1000',
        isGift: false,
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'sub', user, 'se suscribió (Tier 1)', undefined, 'twitch');
    } else if (type === 'resub') {
      emitToActiveRooms('channel:subscription-message', {
        platform: 'twitch',
        userDisplayName: user,
        userName: user.toLowerCase(),
        tier: '1000',
        cumulativeMonths: 12,
        streakMonths: 12,
        messageText: '¡1 año en la comunidad de Twitch!',
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'resub', user, 'renovó suscripción (Tier 1, 12 meses)', undefined, 'twitch');
    } else if (type === 'gift') {
      emitToActiveRooms('channel:subgift', {
        platform: 'twitch',
        gifterDisplayName: user,
        gifterName: user.toLowerCase(),
        tier: '1000',
        amount: 5,
        cumulativeAmount: 5,
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'gift', user, 'regaló 5 suscripción(es) (Tier 1)', 5, 'twitch');
    } else if (type === 'cheer') {
      emitToActiveRooms('channel:cheer', {
        platform: 'twitch',
        userDisplayName: user,
        userName: user.toLowerCase(),
        bits: 500,
        message: 'Cheer500 ¡Sigue así!',
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'cheer', user, 'donó 500 bits', 500, 'twitch');
    } else if (type === 'raid') {
      emitToActiveRooms('channel:raid', {
        platform: 'twitch',
        fromChannel: user.toLowerCase(),
        fromDisplayName: user,
        viewerCount: 42,
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'raid', user, 'hizo raid con 42 espectadores', 42, 'twitch');
    } else if (type === 'redemption') {
      emitToActiveRooms('channel:redemption', {
        platform: 'twitch',
        userDisplayName: user,
        userName: user.toLowerCase(),
        rewardTitle: 'Hidratación',
        rewardCost: 250,
        input: '',
        timestamp: Date.now(),
      });
      recordEvent(targetRoom, 'redemption', user, 'canjeó Hidratación (250 pts)', 250, 'twitch');
    }

    return reply.send({ ok: true, platform, type });
  });
}

