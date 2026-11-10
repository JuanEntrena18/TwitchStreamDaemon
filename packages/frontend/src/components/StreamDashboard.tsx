import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  HudData,
  ChannelFollowEvent,
  ChannelSubscribeEvent,
  ChannelSubscriptionMessageEvent,
  ChannelSubGiftEvent,
  ChannelRedemptionEvent,
  ChannelCheerEvent,
  ChannelRaidEvent,
  YouTubeBroadcastInfo,
  YouTubeCategoryOption,
} from '@streamdaemon/shared';
import { useSocket } from '../contexts/SocketContext';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { apiGet, apiPost, apiPut } from '../utils/api';
import { EmptyState } from './EmptyState';
import s from './StreamDashboard.module.css';

interface ActivityItem {
  id: string;
  type: 'follow' | 'sub' | 'resub' | 'gift' | 'redemption' | 'cheer' | 'raid';
  user: string;
  detail: string;
  timestamp: number;
  amount?: number;
  platform: 'twitch' | 'youtube';
  formattedAmount?: string;
}

interface StoredBackendEvent {
  id: string;
  type: string;
  user: string;
  message: string;
  timestamp: number;
  amount?: number;
  platform?: 'twitch' | 'youtube';
  formattedAmount?: string;
}

interface GameSearchResult {
  id: string;
  name: string;
  boxArtUrl: string;
}

interface TwitchTagsResponse {
  allTags: Array<{ id: string; name: string; isAuto: boolean }>;
  activeTagIds: string[];
  title?: string;
  gameId: string | null;
  gameName: string;
}

type SignalScope = 'multi' | 'twitch' | 'youtube';
type MonitorMode = 'twitch' | 'youtube' | 'dual';
type EditorTarget = 'multi' | 'twitch' | 'youtube';
type ActivityPlatformFilter = 'all' | 'twitch' | 'youtube';

const DEFAULT_YT_CATEGORIES: YouTubeCategoryOption[] = [
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
];

const EVENT_TYPE_META: Record<
  ActivityItem['type'],
  { icon: string; label: string; ytLabel?: string }
> = {
  follow: { icon: '💜', label: 'Follows / Subs YT' },
  sub: { icon: '⭐', label: 'Subs / Miembros' },
  resub: { icon: '🔄', label: 'Re-subs / Hitos' },
  gift: { icon: '🎁', label: 'Gifts' },
  cheer: { icon: '💎', label: 'Bits / SuperChat' },
  raid: { icon: '🚀', label: 'Raids' },
  redemption: { icon: '🎯', label: 'Canjes' },
};

function formatUptime(sec: number): string {
  if (!sec || sec <= 0) return '00:00:00';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const sRem = sec % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(sRem).padStart(2, '0');
  if (d > 0) return `${d}d ${hh}:${mm}:${ss}`;
  return `${hh}:${mm}:${ss}`;
}

function formatEventTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function normalizeActivityType(raw: string): ActivityItem['type'] {
  if (
    raw === 'follow' ||
    raw === 'sub' ||
    raw === 'resub' ||
    raw === 'gift' ||
    raw === 'redemption' ||
    raw === 'cheer' ||
    raw === 'raid'
  ) {
    return raw;
  }
  return 'follow';
}

export function StreamDashboard({ channel }: { channel: string }) {
  const { socket } = useSocket();
  const auth = useAuthStatus();

  const twitchLogin = auth.twitchUser?.login || (auth.twitchAuthenticated ? channel : '') || '';
  const youtubeLogin = auth.youtubeUser?.login || '';
  const effectiveChannel = channel || twitchLogin || youtubeLogin;

  // ── Scope & Monitor State ───────────────────────────────────────────────
  const [signalScope, setSignalScope] = useState<SignalScope>('multi');
  const [monitorMode, setMonitorMode] = useState<MonitorMode>('twitch');
  const [editorTarget, setEditorTarget] = useState<EditorTarget>('twitch');
  const [showPreview, setShowPreview] = useState(true);
  const [previewMuted, setPreviewMuted] = useState(true);
  const [previewKey, setPreviewKey] = useState(0);

  // Sync initial scope/target when auth loads
  const initializedDefaults = useRef(false);
  useEffect(() => {
    if (auth.loading || initializedDefaults.current) return;
    initializedDefaults.current = true;
    if (auth.twitchAuthenticated && auth.youtubeAuthenticated) {
      setSignalScope('multi');
      setMonitorMode('dual');
      setEditorTarget('multi');
    } else if (auth.youtubeAuthenticated && !auth.twitchAuthenticated) {
      setSignalScope('youtube');
      setMonitorMode('youtube');
      setEditorTarget('youtube');
    } else {
      setSignalScope('twitch');
      setMonitorMode('twitch');
      setEditorTarget('twitch');
    }
  }, [auth.loading, auth.twitchAuthenticated, auth.youtubeAuthenticated]);

  // ── HUD & Telemetry State ───────────────────────────────────────────────
  const [hud, setHud] = useState<HudData | null>(null);
  const [refreshingHud, setRefreshingHud] = useState(false);

  // ── Twitch Metadata Editor State ────────────────────────────────────────
  const [twTitle, setTwTitle] = useState('');
  const [twGame, setTwGame] = useState('');
  const [twTags, setTwTags] = useState<string[]>([]);
  const [twTagInput, setTwTagInput] = useState('');
  const [gameResults, setGameResults] = useState<GameSearchResult[]>([]);
  const [showGameDropdown, setShowGameDropdown] = useState(false);
  const gameSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const twInitializedFor = useRef<string | null>(null);

  // ── YouTube Broadcast Metadata Editor State ─────────────────────────────
  const [ytInfo, setYtInfo] = useState<YouTubeBroadcastInfo | null>(null);
  const [ytTitle, setYtTitle] = useState('');
  const [ytDescription, setYtDescription] = useState('');
  const [ytCategoryId, setYtCategoryId] = useState('20');
  const [ytPrivacy, setYtPrivacy] = useState<'public' | 'unlisted' | 'private'>('public');
  const [ytTags, setYtTags] = useState<string[]>([]);
  const [ytTagInput, setYtTagInput] = useState('');
  const [ytManualLinkInput, setYtManualLinkInput] = useState('');
  const [detectingYt, setDetectingYt] = useState(false);
  const ytInitialized = useRef(false);

  // ── Shared Save State ───────────────────────────────────────────────────
  const [savingMeta, setSavingMeta] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // ── Activity Feed State ─────────────────────────────────────────────────
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityPlatformFilter, setActivityPlatformFilter] = useState<ActivityPlatformFilter>('all');
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>('all');
  const [simPlatform, setSimPlatform] = useState<'twitch' | 'youtube'>('twitch');
  const [simType, setSimType] = useState<ActivityItem['type']>('follow');
  const [simulating, setSimulating] = useState(false);

  const pushActivity = useCallback((item: Omit<ActivityItem, 'id'>) => {
    setActivity((prev) => [
      { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
      ...prev.slice(0, 149),
    ]);
  }, []);

  // ── Load HUD, Twitch Tags & YouTube Broadcast Info ──────────────────────
  const fetchAllTelemetry = useCallback(async () => {
    if (!effectiveChannel) return;
    setRefreshingHud(true);
    try {
      const [hudRes, ytBroadcastRes] = await Promise.all([
        apiGet(`/hud/${encodeURIComponent(effectiveChannel)}`)
          .then((r) => (r.ok ? (r.json() as Promise<HudData>) : null))
          .catch(() => null),
        apiGet('/youtube/broadcast/info')
          .then((r) => (r.ok ? (r.json() as Promise<YouTubeBroadcastInfo>) : null))
          .catch(() => null),
      ]);

      if (hudRes) {
        setHud(hudRes);
        const twBreak = hudRes.platformBreakdown?.twitch;
        if (twInitializedFor.current !== effectiveChannel) {
          twInitializedFor.current = effectiveChannel;
          setTwTitle(twBreak?.streamTitle || hudRes.streamTitle || '');
          setTwGame(twBreak?.gameName || hudRes.gameName || '');
        }
      }

      if (ytBroadcastRes) {
        setYtInfo(ytBroadcastRes);
        if (!ytInitialized.current) {
          ytInitialized.current = true;
          setYtTitle(ytBroadcastRes.title || '');
          setYtDescription(ytBroadcastRes.description || '');
          setYtCategoryId(ytBroadcastRes.categoryId || '20');
          setYtPrivacy(ytBroadcastRes.privacyStatus || 'public');
          setYtTags(Array.isArray(ytBroadcastRes.tags) ? ytBroadcastRes.tags : []);
        }
      }
    } finally {
      setRefreshingHud(false);
    }
  }, [effectiveChannel]);

  useEffect(() => {
    if (!effectiveChannel) return;
    fetchAllTelemetry();
    apiPost('/hud/start-poll', { channel: effectiveChannel, interval: 10 }).catch(() => {});

    // Load Twitch channel tags & offline title/game
    const targetTw = twitchLogin || effectiveChannel;
    if (auth.twitchAuthenticated && targetTw) {
      apiGet(`/hud/tags/${encodeURIComponent(targetTw)}`)
        .then((r) => (r.ok ? (r.json() as Promise<TwitchTagsResponse>) : null))
        .then((d) => {
          if (!d) return;
          if (d.activeTagIds) setTwTags(d.activeTagIds);
          if (d.title) setTwTitle((prev) => prev || d.title || '');
          if (d.gameName) setTwGame((prev) => prev || d.gameName || '');
        })
        .catch(() => {});
    }

    // Load persisted activity events
    apiGet(`/activity/${encodeURIComponent(effectiveChannel)}`)
      .then((r) => (r.ok ? (r.json() as Promise<StoredBackendEvent[]>) : []))
      .then((stored) => {
        if (Array.isArray(stored) && stored.length > 0) {
          setActivity(
            stored.map((e) => ({
              id: e.id,
              type: normalizeActivityType(e.type),
              user: e.user,
              detail: e.message,
              timestamp: e.timestamp,
              amount: e.amount,
              platform: e.platform === 'youtube' ? 'youtube' : 'twitch',
              formattedAmount: e.formattedAmount,
            })),
          );
        }
      })
      .catch(() => {});

    return () => {
      apiPost('/hud/stop-poll', {}).catch(() => {});
    };
  }, [effectiveChannel, twitchLogin, auth.twitchAuthenticated, fetchAllTelemetry]);

  // ── Socket.IO Real-Time Subscriptions ───────────────────────────────────
  useEffect(() => {
    if (!effectiveChannel || !socket) return;

    const roomsToJoin = new Set<string>(['global', effectiveChannel.toLowerCase()]);
    if (twitchLogin) roomsToJoin.add(twitchLogin.toLowerCase());
    if (youtubeLogin) roomsToJoin.add(youtubeLogin.toLowerCase());
    for (const r of roomsToJoin) {
      socket.emit('join:channel', r);
    }

    const onHudUpdate = (d: HudData) => {
      setHud(d);
    };

    const onFollow = (d: ChannelFollowEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'follow',
        user: d.userDisplayName,
        detail: plat === 'youtube' ? 'se suscribió al canal de YouTube' : 'siguió el canal',
        timestamp: d.timestamp || Date.now(),
        platform: plat,
      });
    };

    const onSubscribe = (d: ChannelSubscribeEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      const tierLabel = { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' }[d.tier] ?? d.tier;
      pushActivity({
        type: 'sub',
        user: d.userDisplayName,
        detail:
          plat === 'youtube'
            ? 'se unió como miembro del canal en YouTube'
            : `se suscribió (${tierLabel})${d.isGift ? ' [regalo]' : ''}`,
        timestamp: d.timestamp || Date.now(),
        platform: plat,
      });
    };

    const onSubMessage = (d: ChannelSubscriptionMessageEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'resub',
        user: d.userDisplayName,
        detail:
          plat === 'youtube'
            ? `cumplió ${d.cumulativeMonths} meses como miembro${d.messageText ? `: "${d.messageText}"` : ''}`
            : `re-suscripción (${d.cumulativeMonths} meses)${d.messageText ? `: "${d.messageText}"` : ''}`,
        timestamp: d.timestamp || Date.now(),
        amount: d.cumulativeMonths,
        platform: plat,
      });
    };

    const onSubGift = (d: ChannelSubGiftEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'gift',
        user: d.gifterDisplayName,
        detail:
          plat === 'youtube'
            ? `regaló ${d.amount} membresía${d.amount > 1 ? 's' : ''} en YouTube`
            : `regaló ${d.amount} sub${d.amount > 1 ? 's' : ''}`,
        timestamp: d.timestamp || Date.now(),
        amount: d.amount,
        platform: plat,
      });
    };

    const onRedemption = (d: ChannelRedemptionEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'redemption',
        user: d.userDisplayName,
        detail: `canjeó "${d.rewardTitle}" (${d.rewardCost} pts)${d.input ? `: ${d.input}` : ''}`,
        timestamp: d.timestamp || Date.now(),
        amount: d.rewardCost,
        platform: plat,
      });
    };

    const onCheer = (d: ChannelCheerEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'cheer',
        user: d.userDisplayName,
        detail:
          plat === 'youtube'
            ? `envió Super Chat (${d.formattedAmount || `${d.bits} pts`})${d.message ? `: "${d.message}"` : ''}`
            : `envió ${d.bits} bits${d.message ? `: "${d.message}"` : ''}`,
        timestamp: d.timestamp || Date.now(),
        amount: d.bits,
        formattedAmount: d.formattedAmount,
        platform: plat,
      });
    };

    const onRaid = (d: ChannelRaidEvent) => {
      const plat = d.platform === 'youtube' ? 'youtube' : 'twitch';
      pushActivity({
        type: 'raid',
        user: d.fromDisplayName || d.fromChannel,
        detail: `hizo raid con ${d.viewerCount} espectadores`,
        timestamp: d.timestamp || Date.now(),
        amount: d.viewerCount,
        platform: plat,
      });
    };

    socket.on('hud:update', onHudUpdate);
    socket.on('channel:follow', onFollow);
    socket.on('channel:subscribe', onSubscribe);
    socket.on('channel:subscription-message', onSubMessage);
    socket.on('channel:subgift', onSubGift);
    socket.on('channel:redemption', onRedemption);
    socket.on('channel:cheer', onCheer);
    socket.on('channel:raid', onRaid);

    return () => {
      socket.off('hud:update', onHudUpdate);
      socket.off('channel:follow', onFollow);
      socket.off('channel:subscribe', onSubscribe);
      socket.off('channel:subscription-message', onSubMessage);
      socket.off('channel:subgift', onSubGift);
      socket.off('channel:redemption', onRedemption);
      socket.off('channel:cheer', onCheer);
      socket.off('channel:raid', onRaid);
    };
  }, [effectiveChannel, twitchLogin, youtubeLogin, socket, pushActivity]);

  // ── Twitch Category Autocomplete Search ─────────────────────────────────
  const searchGames = (query: string) => {
    setTwGame(query);
    if (gameSearchTimeout.current) clearTimeout(gameSearchTimeout.current);
    if (!query.trim()) {
      setGameResults([]);
      setShowGameDropdown(false);
      return;
    }
    gameSearchTimeout.current = setTimeout(async () => {
      try {
        const res = await apiGet(`/hud/games/search?query=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const data = (await res.json()) as GameSearchResult[];
        if (Array.isArray(data)) {
          setGameResults(data.slice(0, 8));
          setShowGameDropdown(true);
        }
      } catch {
        // Ignore search error when Twitch is not connected
      }
    }, 280);
  };

  const selectGame = (game: GameSearchResult) => {
    setTwGame(game.name);
    setShowGameDropdown(false);
    setGameResults([]);
  };

  // ── Tags Handlers ───────────────────────────────────────────────────────
  const addTwTag = (tag: string) => {
    const clean = tag.trim().replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ]/g, '');
    if (clean && twTags.length < 10 && !twTags.includes(clean)) {
      setTwTags([...twTags, clean]);
    }
    setTwTagInput('');
  };

  const addYtTag = (tag: string) => {
    const clean = tag.trim();
    if (clean && ytTags.length < 15 && !ytTags.includes(clean)) {
      setYtTags([...ytTags, clean]);
    }
    setYtTagInput('');
  };

  // ── Save Broadcast Metadata (Twitch, YouTube, or Multistream Both) ──────
  const handleSaveMetadata = async () => {
    setSavingMeta(true);
    setSaveFeedback(null);
    const messages: string[] = [];
    let hasError = false;

    try {
      // 1. Update Twitch if target is 'twitch' or 'multi'
      if (editorTarget === 'twitch' || editorTarget === 'multi') {
        if (auth.twitchAuthenticated) {
          const targetTw = twitchLogin || effectiveChannel;
          const twPutRes = await apiPut('/hud/stream/info', {
            channel: targetTw,
            title: twTitle,
            gameName: twGame,
            tags: twTags,
          });
          if (!twPutRes.ok) {
            const errData = (await twPutRes.json().catch(() => ({}))) as { message?: string; error?: string };
            hasError = true;
            messages.push(errData.message || errData.error || 'Error al actualizar Twitch');
          } else {
            messages.push('✓ Twitch actualizado');
          }
        } else if (editorTarget === 'twitch') {
          hasError = true;
          messages.push('Conecta tu cuenta de Twitch en Configuración para actualizar el canal.');
        }
      }

      // 2. Update YouTube if target is 'youtube' or 'multi'
      if (editorTarget === 'youtube' || editorTarget === 'multi') {
        const payload =
          editorTarget === 'multi'
            ? {
                title: twTitle || ytTitle,
                description: ytDescription,
                categoryId: ytCategoryId,
                tags: twTags.length > 0 ? twTags : ytTags,
                privacyStatus: ytPrivacy,
              }
            : {
                title: ytTitle,
                description: ytDescription,
                categoryId: ytCategoryId,
                tags: ytTags,
                privacyStatus: ytPrivacy,
              };

        const ytRawRes = await apiPut('/youtube/broadcast/info', payload);
        const ytRes = (await ytRawRes.json()) as {
          ok: boolean;
          syncedToYouTubeApi: boolean;
          broadcastId: string | null;
          message: string;
        };

        if (editorTarget === 'multi' && twTitle) {
          setYtTitle(twTitle);
        }
        messages.push(
          ytRes.syncedToYouTubeApi
            ? '✓ YouTube Live actualizado en directo'
            : `✓ YouTube: ${ytRes.message}`,
        );
      }

      setSaveFeedback({
        ok: !hasError,
        msg: messages.join(' · ') || 'Cambios guardados correctamente.',
      });
      fetchAllTelemetry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al actualizar la información del stream';
      setSaveFeedback({ ok: false, msg });
    } finally {
      setSavingMeta(false);
      setTimeout(() => setSaveFeedback(null), 6000);
    }
  };

  // ── Detect or Link YouTube Broadcast ────────────────────────────────────
  const handleDetectYouTubeBroadcast = async (videoIdOrUrl?: string) => {
    setDetectingYt(true);
    try {
      const rawRes = await apiPost('/youtube/broadcast/detect', { videoIdOrUrl });
      if (!rawRes.ok) return;
      const res = (await rawRes.json()) as {
        ok: boolean;
        broadcastId: string | null;
        liveChatId: string | null;
        info: YouTubeBroadcastInfo;
      };
      if (res.info) {
        setYtInfo(res.info);
        if (res.info.title) setYtTitle(res.info.title);
        if (res.info.description !== undefined) setYtDescription(res.info.description);
        if (res.info.categoryId) setYtCategoryId(res.info.categoryId);
        if (res.info.privacyStatus) setYtPrivacy(res.info.privacyStatus);
        if (Array.isArray(res.info.tags)) setYtTags(res.info.tags);
      }
      setYtManualLinkInput('');
      setPreviewKey((k) => k + 1);
      fetchAllTelemetry();
    } catch {
      // Ignore detection error
    } finally {
      setDetectingYt(false);
    }
  };

  // ── Trigger Simulated Activity Event ────────────────────────────────────
  const handleSimulateActivity = async () => {
    setSimulating(true);
    try {
      await apiPost('/activity/simulate', {
        platform: simPlatform,
        type: simType,
        channel: effectiveChannel,
      });
    } catch {
      // Ignore simulation error
    } finally {
      setSimulating(false);
    }
  };

  // ── Computed Telemetry by Selected Scope ────────────────────────────────
  const twData = hud?.platformBreakdown?.twitch;
  const ytData = hud?.platformBreakdown?.youtube;

  const twLive = Boolean(twData?.isLive ?? (hud?.platform === 'twitch' && hud?.isLive));
  const ytLive = Boolean(ytData?.isLive ?? (hud?.platform === 'youtube' && hud?.isLive));
  const anyLive = twLive || ytLive || Boolean(hud?.isLive);

  const telemetry = useMemo(() => {
    const twViewers = twData?.viewers ?? (hud?.platform !== 'youtube' ? hud?.viewers ?? 0 : 0);
    const ytViewers = ytData?.viewers ?? (hud?.platform === 'youtube' ? hud?.viewers ?? 0 : 0);

    const twFollowers = twData?.followers ?? (hud?.platform !== 'youtube' ? hud?.followers ?? 0 : 0);
    const ytSubscribers = ytData?.subscribers ?? (hud?.platform === 'youtube' ? hud?.followers ?? 0 : 0);

    const twSubs = twData?.subscribers ?? (hud?.platform !== 'youtube' ? hud?.subscribers ?? 0 : 0);
    const ytMembers = ytData?.members ?? 0;

    const twUptime = twData?.uptimeSeconds ?? (hud?.platform !== 'youtube' ? hud?.uptimeSeconds ?? 0 : 0);
    const ytUptime = ytData?.uptimeSeconds ?? (hud?.platform === 'youtube' ? hud?.uptimeSeconds ?? 0 : 0);

    if (signalScope === 'twitch') {
      return {
        viewers: twViewers,
        community: twFollowers,
        communityLabel: 'Seguidores en Twitch',
        paid: twSubs,
        paidLabel: 'Suscriptores de pago (TW)',
        uptime: twUptime,
        isLive: twLive,
        activeTitle: twData?.streamTitle || twTitle || 'Sin título en Twitch',
        activeCategory: twData?.gameName || twGame || 'Sin categoría',
        twViewers,
        ytViewers,
        twFollowers,
        ytSubscribers,
        twSubs,
        ytMembers,
      };
    }

    if (signalScope === 'youtube') {
      return {
        viewers: ytViewers,
        community: ytSubscribers,
        communityLabel: 'Suscriptores en YouTube',
        paid: ytMembers,
        paidLabel: 'Miembros del canal (YT)',
        uptime: ytUptime,
        isLive: ytLive,
        activeTitle: ytData?.streamTitle || ytTitle || ytInfo?.title || 'Sin título en YouTube',
        activeCategory: ytData?.categoryName || ytInfo?.categoryName || 'YouTube Live',
        twViewers,
        ytViewers,
        twFollowers,
        ytSubscribers,
        twSubs,
        ytMembers,
      };
    }

    // Multistream combined
    return {
      viewers: twViewers + ytViewers,
      community: twFollowers + ytSubscribers,
      communityLabel: 'Comunidad total (TW + YT)',
      paid: twSubs + ytMembers,
      paidLabel: 'Suscriptores TW + Miembros YT',
      uptime: Math.max(twUptime, ytUptime),
      isLive: anyLive,
      activeTitle:
        (twLive ? twData?.streamTitle : ytLive ? ytData?.streamTitle : twData?.streamTitle || ytData?.streamTitle) ||
        hud?.streamTitle ||
        twTitle ||
        ytTitle ||
        effectiveChannel,
      activeCategory:
        twData?.gameName || ytData?.categoryName || hud?.gameName || twGame || 'Multistream',
      twViewers,
      ytViewers,
      twFollowers,
      ytSubscribers,
      twSubs,
      ytMembers,
    };
  }, [hud, twData, ytData, twLive, ytLive, anyLive, signalScope, twTitle, twGame, ytTitle, ytInfo, effectiveChannel]);

  // ── Filtered Activity Feed ──────────────────────────────────────────────
  const filteredActivity = useMemo(() => {
    return activity.filter((item) => {
      if (activityPlatformFilter !== 'all' && item.platform !== activityPlatformFilter) {
        return false;
      }
      if (activityTypeFilter !== 'all' && item.type !== activityTypeFilter) {
        return false;
      }
      return true;
    });
  }, [activity, activityPlatformFilter, activityTypeFilter]);

  const platformCounts = useMemo(() => {
    let tw = 0;
    let yt = 0;
    for (const item of activity) {
      if (item.platform === 'youtube') yt++;
      else tw++;
    }
    return { all: activity.length, tw, yt };
  }, [activity]);

  if (!effectiveChannel) {
    return (
      <EmptyState
        icon="📡"
        title="Sin señal de canal configurada"
        description="Conecta tu cuenta de Twitch o tu canal de YouTube Live en Configuración para activar la consola maestra de emisión."
      />
    );
  }

  const ytBroadcastId = ytData?.liveBroadcastId || ytInfo?.liveBroadcastId || null;
  const ytChannelId = ytData?.channelId || ytInfo?.channelId || auth.youtubeUser?.id || '';
  const ytCategories = ytInfo?.categories?.length ? ytInfo.categories : DEFAULT_YT_CATEGORIES;

  const twitchEmbedUrl = twitchLogin || effectiveChannel
    ? `https://player.twitch.tv/?channel=${encodeURIComponent(twitchLogin || effectiveChannel)}&parent=${window.location.hostname || 'localhost'}&muted=${previewMuted}`
    : null;

  const youtubeEmbedUrl = ytBroadcastId
    ? `https://www.youtube.com/embed/${encodeURIComponent(ytBroadcastId)}?autoplay=1&mute=${previewMuted ? 1 : 0}`
    : ytChannelId
      ? `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(ytChannelId)}&autoplay=1&mute=${previewMuted ? 1 : 0}`
      : null;

  return (
    <div className={s.mcrRoot}>
      {/* ═══════════════════════════════════════════════════════════════════
          1. TOP MASTER CONTROL HEADER & TELEMETRY STRIP
         ═══════════════════════════════════════════════════════════════════ */}
      <section className={`${s.mcrDeck} ${anyLive ? s.mcrDeckLive : ''}`}>
        <div className={s.mcrTopBar}>
          <div className={s.identityGroup}>
            <div className={s.signalIndicators}>
              {/* Twitch Signal Status Pill */}
              <span
                className={`${s.signalPill} ${
                  twLive ? s.signalPillTwitchLive : s.signalPillStandby
                }`}
                title={
                  auth.twitchAuthenticated
                    ? `Twitch: ${twitchLogin} (${twLive ? 'En directo' : 'Offline'})`
                    : 'Twitch no conectado'
                }
              >
                <span className={`${s.pulseDot} ${twLive ? s.pulseDotLive : ''}`} />
                TW {twLive ? 'EN VIVO' : auth.twitchAuthenticated ? 'STANDBY' : 'OFF'}
              </span>

              {/* YouTube Signal Status Pill */}
              <span
                className={`${s.signalPill} ${
                  ytLive ? s.signalPillYoutubeLive : s.signalPillStandby
                }`}
                title={
                  auth.youtubeAuthenticated
                    ? `YouTube: ${auth.youtubeUser?.displayName || youtubeLogin} (${ytLive ? 'En directo' : 'Standby'})`
                    : 'YouTube no conectado'
                }
              >
                <span className={`${s.pulseDot} ${ytLive ? s.pulseDotLive : ''}`} />
                YT {ytLive ? 'EN VIVO' : auth.youtubeAuthenticated ? 'STANDBY' : 'OFF'}
              </span>
            </div>

            <div className={s.streamMetaSummary}>
              <div className={s.streamHeadline}>{telemetry.activeTitle}</div>
              <div className={s.streamSubline}>
                <span className={s.categoryChip}>{telemetry.activeCategory}</span>
                {hud?.lastFollower && (
                  <span>· Último seguidor: {hud.lastFollower}</span>
                )}
              </div>
            </div>
          </div>

          <div className={s.headerControls}>
            {/* Signal Scope Switcher */}
            <div className={s.scopeSwitcher} role="tablist" aria-label="Alcance de telemetría">
              <button
                type="button"
                className={`${s.scopeBtn} ${signalScope === 'multi' ? s.scopeBtnActiveMulti : ''}`}
                onClick={() => setSignalScope('multi')}
              >
                ⚡ Multistream
              </button>
              <button
                type="button"
                className={`${s.scopeBtn} ${signalScope === 'twitch' ? s.scopeBtnActiveTwitch : ''}`}
                onClick={() => setSignalScope('twitch')}
              >
                🟣 Twitch
              </button>
              <button
                type="button"
                className={`${s.scopeBtn} ${signalScope === 'youtube' ? s.scopeBtnActiveYoutube : ''}`}
                onClick={() => setSignalScope('youtube')}
              >
                🔴 YouTube
              </button>
            </div>

            {/* External Quick Links */}
            <div className={s.quickLinksGroup}>
              {(twitchLogin || (!auth.youtubeAuthenticated && effectiveChannel)) && (
                <a
                  href={`https://twitch.tv/${twitchLogin || effectiveChannel}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${s.externalLink} ${s.externalLinkTwitch}`}
                >
                  Twitch ↗
                </a>
              )}
              {auth.youtubeAuthenticated && (
                <>
                  <a
                    href={
                      ytBroadcastId
                        ? `https://www.youtube.com/watch?v=${ytBroadcastId}`
                        : `https://www.youtube.com/channel/${ytChannelId}/live`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${s.externalLink} ${s.externalLinkYoutube}`}
                  >
                    YouTube ↗
                  </a>
                  <a
                    href="https://studio.youtube.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${s.externalLink} ${s.externalLinkYoutube}`}
                  >
                    YT Studio ↗
                  </a>
                </>
              )}
              <button
                type="button"
                className={s.iconBtn}
                onClick={fetchAllTelemetry}
                disabled={refreshingHud}
                title="Sincronizar estadísticas de Twitch y YouTube ahora"
              >
                {refreshingHud ? '⟳ Sincronizando...' : '↻ Actualizar'}
              </button>
            </div>
          </div>
        </div>

        {/* 4-Column Structural Telemetry Strip */}
        <div className={s.telemetryStrip}>
          {/* 1. Concurrent Viewers */}
          <div className={s.telemetryCell}>
            <div className={s.telemetryLabelRow}>
              <span className={s.telemetryLabel}>Espectadores en directo</span>
            </div>
            <div className={s.telemetryPrimaryValue}>
              {telemetry.viewers.toLocaleString('es-ES')}
            </div>
            <div className={s.telemetryBreakdownRow}>
              <span className={`${s.platformMetricBadge} ${s.badgeTwitch}`}>
                TW {telemetry.twViewers.toLocaleString('es-ES')}
              </span>
              <span className={`${s.platformMetricBadge} ${s.badgeYoutube}`}>
                YT {telemetry.ytViewers.toLocaleString('es-ES')}
              </span>
            </div>
          </div>

          {/* 2. Total Community (Twitch Followers + YouTube Subscribers) */}
          <div className={s.telemetryCell}>
            <div className={s.telemetryLabelRow}>
              <span className={s.telemetryLabel}>{telemetry.communityLabel}</span>
            </div>
            <div className={s.telemetryPrimaryValue}>
              {telemetry.community.toLocaleString('es-ES')}
            </div>
            <div className={s.telemetryBreakdownRow}>
              <span className={`${s.platformMetricBadge} ${s.badgeTwitch}`} title="Seguidores en Twitch">
                TW {telemetry.twFollowers.toLocaleString('es-ES')}
              </span>
              <span className={`${s.platformMetricBadge} ${s.badgeYoutube}`} title="Suscriptores del canal de YouTube">
                YT {telemetry.ytSubscribers.toLocaleString('es-ES')}
              </span>
            </div>
          </div>

          {/* 3. Paid Subscriptions & Memberships */}
          <div className={s.telemetryCell}>
            <div className={s.telemetryLabelRow}>
              <span className={s.telemetryLabel}>{telemetry.paidLabel}</span>
            </div>
            <div className={s.telemetryPrimaryValue}>
              {telemetry.paid.toLocaleString('es-ES')}
            </div>
            <div className={s.telemetryBreakdownRow}>
              <span className={`${s.platformMetricBadge} ${s.badgeTwitch}`} title="Suscriptores activos en Twitch">
                TW Subs {telemetry.twSubs.toLocaleString('es-ES')}
              </span>
              <span className={`${s.platformMetricBadge} ${s.badgeYoutube}`} title="Miembros activos en YouTube">
                YT Miembros {telemetry.ytMembers.toLocaleString('es-ES')}
              </span>
            </div>
          </div>

          {/* 4. On-Air Uptime Chronometer */}
          <div className={s.telemetryCell}>
            <div className={s.telemetryLabelRow}>
              <span className={s.telemetryLabel}>Tiempo en aire</span>
            </div>
            <div className={s.telemetryPrimaryValue}>
              {telemetry.isLive ? formatUptime(telemetry.uptime) : '00:00:00'}
            </div>
            <div className={s.telemetryBreakdownRow}>
              <span className={s.telemetrySubnote}>
                {telemetry.isLive
                  ? `Señal activa (${[twLive ? 'Twitch' : null, ytLive ? 'YouTube' : null]
                      .filter(Boolean)
                      .join(' + ')})`
                  : 'Ambos canales en modo espera'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════
          2. MAIN TWO-COLUMN BROADCAST CONSOLE
         ═══════════════════════════════════════════════════════════════════ */}
      <div className={s.consoleGrid}>
        {/* ── LEFT COLUMN: Video Signal Monitor + Multistream Activity Log ── */}
        <div className={s.leftColumn}>
          {/* Video Monitor Frame */}
          <section className={s.panelFrame}>
            <div className={s.panelHeader}>
              <div className={s.panelTitleGroup}>
                <span className={s.panelTitle}>Monitor de señal en vivo</span>
                <div className={s.scopeSwitcher}>
                  <button
                    type="button"
                    className={`${s.scopeBtn} ${
                      monitorMode === 'twitch' ? s.scopeBtnActiveTwitch : ''
                    }`}
                    onClick={() => setMonitorMode('twitch')}
                  >
                    🟣 Twitch
                  </button>
                  <button
                    type="button"
                    className={`${s.scopeBtn} ${
                      monitorMode === 'youtube' ? s.scopeBtnActiveYoutube : ''
                    }`}
                    onClick={() => setMonitorMode('youtube')}
                  >
                    🔴 YouTube
                  </button>
                  <button
                    type="button"
                    className={`${s.scopeBtn} ${
                      monitorMode === 'dual' ? s.scopeBtnActiveMulti : ''
                    }`}
                    onClick={() => setMonitorMode('dual')}
                  >
                    ⚡ Doble 50/50
                  </button>
                </div>
              </div>

              <div className={s.monitorControls}>
                <button
                  type="button"
                  className={s.iconBtn}
                  onClick={() => setPreviewMuted((m) => !m)}
                  title={previewMuted ? 'Activar audio del monitor' : 'Silenciar monitor'}
                >
                  {previewMuted ? '🔇 Silenciado' : '🔊 Audio activo'}
                </button>
                <button
                  type="button"
                  className={s.iconBtn}
                  onClick={() => setPreviewKey((k) => k + 1)}
                  title="Recargar reproductor de vídeo"
                >
                  ↻ Recargar
                </button>
                <button
                  type="button"
                  className={s.iconBtn}
                  onClick={() => setShowPreview((v) => !v)}
                >
                  {showPreview ? 'Ocultar monitor' : 'Mostrar monitor'}
                </button>
              </div>
            </div>

            {showPreview && (
              <>
                {monitorMode === 'dual' ? (
                  <div className={s.monitorViewportDual}>
                    {/* Left Pane: Twitch */}
                    <div className={s.monitorPane}>
                      <span className={`${s.monitorCornerTag} ${s.cornerTwitch}`}>
                        TWITCH · {(twitchLogin || effectiveChannel).toUpperCase()}
                      </span>
                      {twitchEmbedUrl ? (
                        <iframe
                          key={`tw-dual-${previewKey}-${previewMuted}`}
                          src={twitchEmbedUrl}
                          className={s.monitorIframe}
                          allowFullScreen
                          title="Monitor de señal Twitch"
                        />
                      ) : (
                        <div className={s.monitorStandby}>
                          <div className={s.standbyTitle}>Señal de Twitch no disponible</div>
                        </div>
                      )}
                    </div>

                    {/* Right Pane: YouTube */}
                    <div className={s.monitorPane}>
                      <span className={`${s.monitorCornerTag} ${s.cornerYoutube}`}>
                        YOUTUBE · {(auth.youtubeUser?.displayName || 'LIVE').toUpperCase()}
                      </span>
                      {youtubeEmbedUrl ? (
                        <iframe
                          key={`yt-dual-${previewKey}-${previewMuted}-${ytBroadcastId || 'ch'}`}
                          src={youtubeEmbedUrl}
                          className={s.monitorIframe}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          title="Monitor de señal YouTube Live"
                        />
                      ) : (
                        <div className={s.monitorStandby}>
                          <div className={s.standbyTitle}>Señal de YouTube en espera</div>
                          <div className={s.standbyHint}>
                            Conecta tu canal de YouTube o vincula el ID de tu emisión en directo abajo.
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : monitorMode === 'youtube' ? (
                  <div className={s.monitorViewport}>
                    <span className={`${s.monitorCornerTag} ${s.cornerYoutube}`}>
                      YOUTUBE LIVE · {(auth.youtubeUser?.displayName || youtubeLogin || 'SEÑAL').toUpperCase()}
                    </span>
                    {youtubeEmbedUrl ? (
                      <iframe
                        key={`yt-single-${previewKey}-${previewMuted}-${ytBroadcastId || 'ch'}`}
                        src={youtubeEmbedUrl}
                        className={s.monitorIframe}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        title="Monitor de señal YouTube Live"
                      />
                    ) : (
                      <div className={s.monitorStandby}>
                        <div className={s.standbyTitle}>Sin señal de YouTube Live activa</div>
                        <div className={s.standbyHint}>
                          Pulsa «Detectar emisión» abajo o pega la URL/ID de tu directo de YouTube para previsualizar el vídeo y enlazar el chat en vivo.
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={s.monitorViewport}>
                    <span className={`${s.monitorCornerTag} ${s.cornerTwitch}`}>
                      TWITCH · {(twitchLogin || effectiveChannel).toUpperCase()}
                    </span>
                    {twitchEmbedUrl ? (
                      <iframe
                        key={`tw-single-${previewKey}-${previewMuted}`}
                        src={twitchEmbedUrl}
                        className={s.monitorIframe}
                        allowFullScreen
                        title="Monitor de señal Twitch"
                      />
                    ) : (
                      <div className={s.monitorStandby}>
                        <div className={s.standbyTitle}>Sin canal de Twitch configurado</div>
                      </div>
                    )}
                  </div>
                )}

                {/* YouTube Live Broadcast Control Bar */}
                {(monitorMode === 'youtube' || monitorMode === 'dual' || auth.youtubeAuthenticated) && (
                  <div className={s.ytBroadcastBar}>
                    <div className={s.ytBroadcastStatus}>
                      <span>🔴 Emisión YT:</span>
                      {ytBroadcastId ? (
                        <>
                          <code className={s.ytBroadcastIdCode}>{ytBroadcastId}</code>
                          <button
                            type="button"
                            className={s.iconBtn}
                            onClick={() => handleDetectYouTubeBroadcast('')}
                            disabled={detectingYt}
                            title="Re-escanear emisión automática del canal"
                          >
                            {detectingYt ? 'Buscando...' : '↻ Auto-detectar'}
                          </button>
                        </>
                      ) : (
                        <>
                          <span>No detectada automáticamente</span>
                          <button
                            type="button"
                            className={s.iconBtn}
                            onClick={() => handleDetectYouTubeBroadcast()}
                            disabled={detectingYt}
                          >
                            {detectingYt ? 'Buscando...' : '🔍 Detectar directo'}
                          </button>
                        </>
                      )}
                    </div>

                    <div className={s.ytLinkForm}>
                      <input
                        type="text"
                        className={s.ytLinkInput}
                        value={ytManualLinkInput}
                        onChange={(e) => setYtManualLinkInput(e.target.value)}
                        placeholder="Pegar URL o ID de directo YouTube..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && ytManualLinkInput.trim()) {
                            handleDetectYouTubeBroadcast(ytManualLinkInput);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className={s.iconBtn}
                        disabled={!ytManualLinkInput.trim() || detectingYt}
                        onClick={() => handleDetectYouTubeBroadcast(ytManualLinkInput)}
                      >
                        Vincular
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Multistream Recent Activity Feed */}
          <section className={s.panelFrame}>
            <div className={s.panelHeader}>
              <div className={s.panelTitleGroup}>
                <span className={s.panelTitle}>Actividad reciente del canal</span>
                <span className={s.panelCountBadge}>{filteredActivity.length}</span>
              </div>

              {/* Platform Filter Switcher */}
              <div className={s.scopeSwitcher}>
                <button
                  type="button"
                  className={`${s.scopeBtn} ${
                    activityPlatformFilter === 'all' ? s.scopeBtnActiveMulti : ''
                  }`}
                  onClick={() => setActivityPlatformFilter('all')}
                >
                  Todas ({platformCounts.all})
                </button>
                <button
                  type="button"
                  className={`${s.scopeBtn} ${
                    activityPlatformFilter === 'twitch' ? s.scopeBtnActiveTwitch : ''
                  }`}
                  onClick={() => setActivityPlatformFilter('twitch')}
                >
                  🟣 Twitch ({platformCounts.tw})
                </button>
                <button
                  type="button"
                  className={`${s.scopeBtn} ${
                    activityPlatformFilter === 'youtube' ? s.scopeBtnActiveYoutube : ''
                  }`}
                  onClick={() => setActivityPlatformFilter('youtube')}
                >
                  🔴 YouTube ({platformCounts.yt})
                </button>
              </div>
            </div>

            <div className={s.activityToolbar}>
              <div className={s.activityFilterRow}>
                {/* Event Type Filters */}
                <div className={s.typePillsRow}>
                  <button
                    type="button"
                    className={`${s.filterPill} ${
                      activityTypeFilter === 'all' ? s.filterPillActive : ''
                    }`}
                    onClick={() => setActivityTypeFilter('all')}
                  >
                    Todos
                  </button>
                  {(Object.keys(EVENT_TYPE_META) as Array<ActivityItem['type']>).map((key) => {
                    const meta = EVENT_TYPE_META[key];
                    const count = activity.filter(
                      (a) =>
                        a.type === key &&
                        (activityPlatformFilter === 'all' || a.platform === activityPlatformFilter),
                    ).length;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`${s.filterPill} ${
                          activityTypeFilter === key ? s.filterPillActive : ''
                        }`}
                        onClick={() =>
                          setActivityTypeFilter(activityTypeFilter === key ? 'all' : key)
                        }
                      >
                        <span>{meta.icon}</span>
                        <span>{meta.label}</span>
                        {count > 0 && <span className={s.pillCount}>{count}</span>}
                      </button>
                    );
                  })}
                </div>

                {/* Quick Activity Event Simulator */}
                <div className={s.testEventBar}>
                  <select
                    className={s.testSelect}
                    value={simPlatform}
                    onChange={(e) => setSimPlatform(e.target.value as 'twitch' | 'youtube')}
                    aria-label="Plataforma de prueba"
                  >
                    <option value="twitch">🟣 Simular Twitch</option>
                    <option value="youtube">🔴 Simular YouTube</option>
                  </select>
                  <select
                    className={s.testSelect}
                    value={simType}
                    onChange={(e) => setSimType(e.target.value as ActivityItem['type'])}
                    aria-label="Tipo de evento de prueba"
                  >
                    <option value="follow">
                      {simPlatform === 'youtube' ? 'Nuevo suscriptor YT' : 'Nuevo seguidor TW'}
                    </option>
                    <option value="sub">
                      {simPlatform === 'youtube' ? 'Nuevo miembro YT' : 'Suscripción Tier 1'}
                    </option>
                    <option value="resub">
                      {simPlatform === 'youtube' ? 'Hito de miembro (6m)' : 'Re-suscripción (12m)'}
                    </option>
                    <option value="gift">
                      {simPlatform === 'youtube' ? '5 Membresías regaladas' : '5 Subs regaladas'}
                    </option>
                    <option value="cheer">
                      {simPlatform === 'youtube' ? 'Super Chat (10,00 €)' : 'Donación 500 Bits'}
                    </option>
                    {simPlatform === 'twitch' && (
                      <>
                        <option value="raid">Raid (42 viewers)</option>
                        <option value="redemption">Canje de puntos</option>
                      </>
                    )}
                  </select>
                  <button
                    type="button"
                    className={s.iconBtn}
                    onClick={handleSimulateActivity}
                    disabled={simulating}
                    title="Disparar evento de prueba en el feed y en los overlays activos"
                  >
                    ⚡ Probar
                  </button>
                </div>
              </div>
            </div>

            {filteredActivity.length === 0 ? (
              <div className={s.emptyActivityBox}>
                No hay eventos registrados para este filtro. Los follows, suscripciones, miembros de YouTube, Super Chats, bits, raids y canjes aparecerán aquí en tiempo real.
              </div>
            ) : (
              <div className={s.activityFeedList}>
                {filteredActivity.map((item) => {
                  const meta = EVENT_TYPE_META[item.type] || EVENT_TYPE_META.follow;
                  return (
                    <div key={item.id} className={s.activityRow}>
                      <span
                        className={`${s.platformTag} ${
                          item.platform === 'youtube' ? s.platformTagYoutube : s.platformTagTwitch
                        }`}
                      >
                        {item.platform === 'youtube' ? 'YT' : 'TW'}
                      </span>
                      <span className={s.eventTypeBadge} title={meta.label}>
                        {meta.icon}
                      </span>
                      <div className={s.activityMainText}>
                        <span className={s.activityActor}>{item.user}</span>
                        <span>{item.detail}</span>
                        {item.formattedAmount && (
                          <span className={s.activityAmountChip}>{item.formattedAmount}</span>
                        )}
                      </div>
                      <span className={s.activityTime}>{formatEventTime(item.timestamp)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* ── RIGHT COLUMN: Consola de Metadatos de Emisión (Twitch + YouTube) ── */}
        <div className={s.rightColumn}>
          <section className={s.panelFrame}>
            <div className={s.panelHeader}>
              <div className={s.panelTitleGroup}>
                <span className={s.panelTitle}>Consola de metadatos de emisión</span>
              </div>
              <span className={s.panelCountBadge}>
                {editorTarget === 'multi'
                  ? 'Sincronización Dual'
                  : editorTarget === 'youtube'
                    ? 'YouTube Studio API'
                    : 'Twitch Broadcast API'}
              </span>
            </div>

            {/* Platform Target Tabs */}
            <div className={s.editorTargetTabs}>
              <button
                type="button"
                className={`${s.targetTabBtn} ${
                  editorTarget === 'twitch' ? s.targetTabTwitchActive : ''
                }`}
                onClick={() => setEditorTarget('twitch')}
              >
                🟣 Canal de Twitch
              </button>
              <button
                type="button"
                className={`${s.targetTabBtn} ${
                  editorTarget === 'youtube' ? s.targetTabYoutubeActive : ''
                }`}
                onClick={() => setEditorTarget('youtube')}
              >
                🔴 YouTube Live
              </button>
              <button
                type="button"
                className={`${s.targetTabBtn} ${
                  editorTarget === 'multi' ? s.targetTabMultiActive : ''
                }`}
                onClick={() => setEditorTarget('multi')}
              >
                ⚡ Ambos (Multistream)
              </button>
            </div>

            <div className={s.editorBody}>
              {/* Contextual Platform Notice */}
              {editorTarget === 'youtube' && auth.youtubeAuthenticated && auth.youtubeAuthMode === 'apikey' && (
                <div className={s.platformNotice}>
                  <span>
                    Conectado a YouTube en modo lectura rápida (API Key). Tus cambios actualizarán el HUD y se guardarán como plantilla; para modificar el directo en YouTube Studio automáticamente, conecta OAuth 2.0 en Configuración.
                  </span>
                </div>
              )}

              {editorTarget === 'multi' && (
                <div className={`${s.platformNotice} ${s.platformNoticeInfo}`}>
                  <span>
                    Modo Multistream: al guardar se aplicarán el título, la categoría y las etiquetas simultáneamente en tu canal de Twitch y en tu emisión de YouTube Live.
                  </span>
                </div>
              )}

              {/* ── TWITCH OR MULTISTREAM FIELDS ────────────────────────── */}
              {(editorTarget === 'twitch' || editorTarget === 'multi') && (
                <>
                  {/* Stream Title */}
                  <div className={s.fieldGroup}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>
                        {editorTarget === 'multi'
                          ? 'Título unificado del directo (Twitch + YouTube)'
                          : 'Título del directo en Twitch'}
                      </label>
                      <span className={s.charCount}>
                        {twTitle.length}/{editorTarget === 'multi' ? 100 : 140}
                      </span>
                    </div>
                    <input
                      type="text"
                      className={s.textInput}
                      value={twTitle}
                      maxLength={editorTarget === 'multi' ? 100 : 140}
                      onChange={(e) => setTwTitle(e.target.value)}
                      placeholder="Ej: ¡Noche de clasificatorias y charlando con el chat! 🔥"
                    />
                  </div>

                  {/* Twitch Game / Category Search */}
                  <div className={`${s.fieldGroup} ${s.categorySearchWrap}`}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>Categoría / Juego en Twitch</label>
                    </div>
                    <input
                      type="text"
                      className={s.textInput}
                      value={twGame}
                      onChange={(e) => searchGames(e.target.value)}
                      onFocus={() => gameResults.length > 0 && setShowGameDropdown(true)}
                      onBlur={() => setTimeout(() => setShowGameDropdown(false), 200)}
                      placeholder="Buscar categoría oficial en Twitch (Just Chatting, Fortnite, Valorant...)"
                    />
                    {showGameDropdown && gameResults.length > 0 && (
                      <div className={s.gameDropdown}>
                        {gameResults.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            className={s.gameOptionBtn}
                            onMouseDown={() => selectGame(g)}
                          >
                            {g.boxArtUrl && (
                              <img
                                src={g.boxArtUrl.replace('{width}', '52').replace('{height}', '72')}
                                alt=""
                                className={s.gameBoxArt}
                              />
                            )}
                            <span>{g.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* In Multistream mode, also show YouTube Category & Privacy selector side-by-side */}
                  {editorTarget === 'multi' && (
                    <div className={s.twoColFields}>
                      <div className={s.fieldGroup}>
                        <label className={s.fieldLabel}>Categoría en YouTube Live</label>
                        <select
                          className={s.selectInput}
                          value={ytCategoryId}
                          onChange={(e) => setYtCategoryId(e.target.value)}
                        >
                          {ytCategories.map((cat) => (
                            <option key={cat.id} value={cat.id}>
                              {cat.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className={s.fieldGroup}>
                        <label className={s.fieldLabel}>Visibilidad en YouTube</label>
                        <select
                          className={s.selectInput}
                          value={ytPrivacy}
                          onChange={(e) =>
                            setYtPrivacy(e.target.value as 'public' | 'unlisted' | 'private')
                          }
                        >
                          <option value="public">🌐 Público</option>
                          <option value="unlisted">🔗 Oculto (Unlisted)</option>
                          <option value="private">🔒 Privado</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Tags (Twitch / Unified) */}
                  <div className={s.fieldGroup}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>
                        {editorTarget === 'multi'
                          ? 'Etiquetas del directo (Twitch y YouTube)'
                          : 'Etiquetas de Twitch'}
                      </label>
                      <span className={s.charCount}>{twTags.length}/10</span>
                    </div>
                    {twTags.length > 0 && (
                      <div className={s.tagsList}>
                        {twTags.map((tag) => (
                          <span key={tag} className={s.tagBadge}>
                            {tag}
                            <button
                              type="button"
                              className={s.tagRemoveBtn}
                              onClick={() => setTwTags(twTags.filter((t) => t !== tag))}
                              title="Eliminar etiqueta"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {twTags.length < 10 && (
                      <div className={s.tagAddRow}>
                        <input
                          type="text"
                          className={s.textInput}
                          value={twTagInput}
                          maxLength={25}
                          onChange={(e) => setTwTagInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && twTagInput.trim()) {
                              e.preventDefault();
                              addTwTag(twTagInput);
                            }
                          }}
                          placeholder="Añadir etiqueta (ej: Español, SinComentarios, Competitivo)..."
                        />
                        <button
                          type="button"
                          className={s.iconBtn}
                          disabled={!twTagInput.trim()}
                          onClick={() => addTwTag(twTagInput)}
                        >
                          + Añadir
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ── YOUTUBE LIVE DEDICATED FIELDS ───────────────────────── */}
              {editorTarget === 'youtube' && (
                <>
                  {/* YouTube Broadcast Title */}
                  <div className={s.fieldGroup}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>Título de la emisión en YouTube Live</label>
                      <span className={s.charCount}>{ytTitle.length}/100</span>
                    </div>
                    <input
                      type="text"
                      className={s.textInput}
                      value={ytTitle}
                      maxLength={100}
                      onChange={(e) => setYtTitle(e.target.value)}
                      placeholder="Título del directo en YouTube (máx. 100 caracteres)..."
                    />
                  </div>

                  {/* YouTube Category & Privacy */}
                  <div className={s.twoColFields}>
                    <div className={s.fieldGroup}>
                      <label className={s.fieldLabel}>Categoría de vídeo en YouTube</label>
                      <select
                        className={s.selectInput}
                        value={ytCategoryId}
                        onChange={(e) => setYtCategoryId(e.target.value)}
                      >
                        {ytCategories.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className={s.fieldGroup}>
                      <label className={s.fieldLabel}>Privacidad de la emisión</label>
                      <select
                        className={s.selectInput}
                        value={ytPrivacy}
                        onChange={(e) =>
                          setYtPrivacy(e.target.value as 'public' | 'unlisted' | 'private')
                        }
                      >
                        <option value="public">🌐 Público</option>
                        <option value="unlisted">🔗 Oculto (Unlisted)</option>
                        <option value="private">🔒 Privado</option>
                      </select>
                    </div>
                  </div>

                  {/* YouTube Broadcast Description */}
                  <div className={s.fieldGroup}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>Descripción del directo en YouTube</label>
                      <span className={s.charCount}>{ytDescription.length}/5000</span>
                    </div>
                    <textarea
                      className={s.textareaInput}
                      value={ytDescription}
                      maxLength={5000}
                      onChange={(e) => setYtDescription(e.target.value)}
                      placeholder="Descripción, redes sociales, comandos del chat y enlaces de tu emisión de YouTube..."
                    />
                  </div>

                  {/* YouTube Tags */}
                  <div className={s.fieldGroup}>
                    <div className={s.fieldLabelRow}>
                      <label className={s.fieldLabel}>Etiquetas de YouTube (SEO)</label>
                      <span className={s.charCount}>{ytTags.length}/15</span>
                    </div>
                    {ytTags.length > 0 && (
                      <div className={s.tagsList}>
                        {ytTags.map((tag) => (
                          <span key={tag} className={s.tagBadge}>
                            {tag}
                            <button
                              type="button"
                              className={s.tagRemoveBtn}
                              onClick={() => setYtTags(ytTags.filter((t) => t !== tag))}
                              title="Eliminar etiqueta"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {ytTags.length < 15 && (
                      <div className={s.tagAddRow}>
                        <input
                          type="text"
                          className={s.textInput}
                          value={ytTagInput}
                          maxLength={35}
                          onChange={(e) => setYtTagInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && ytTagInput.trim()) {
                              e.preventDefault();
                              addYtTag(ytTagInput);
                            }
                          }}
                          placeholder="Añadir etiqueta para YouTube..."
                        />
                        <button
                          type="button"
                          className={s.iconBtn}
                          disabled={!ytTagInput.trim()}
                          onClick={() => addYtTag(ytTagInput)}
                        >
                          + Añadir
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Save Footer */}
              <div className={s.editorFooter}>
                <button
                  type="button"
                  className={s.savePrimaryBtn}
                  onClick={handleSaveMetadata}
                  disabled={savingMeta}
                >
                  {savingMeta
                    ? 'Sincronizando metadatos...'
                    : editorTarget === 'multi'
                      ? '⚡ Aplicar cambios en Twitch y YouTube Live'
                      : editorTarget === 'youtube'
                        ? '🔴 Guardar metadatos de YouTube Live'
                        : '🟣 Actualizar canal de Twitch'}
                </button>

                {saveFeedback && (
                  <div
                    className={`${s.feedbackBanner} ${
                      saveFeedback.ok ? s.feedbackSuccess : s.feedbackError
                    }`}
                  >
                    {saveFeedback.msg}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Dual-Channel Live Status Summary Box */}
          <div className={s.platformCardsGrid}>
            <div className={s.platformStatusCard}>
              <div className={s.platformStatusHeader}>
                <span style={{ color: '#c4b5fd' }}>🟣 Señal Twitch</span>
                <span className={ s.charCount }>
                  {auth.twitchAuthenticated ? (twLive ? 'EN VIVO' : 'CONECTADO') : 'NO CONECTADO'}
                </span>
              </div>
              <div className={s.platformStatusDetail}>
                Canal: <strong>{auth.twitchUser?.displayName || twitchLogin || '—'}</strong>
              </div>
              <div className={s.platformStatusDetail}>
                Categoría: {twData?.gameName || twGame || '—'}
              </div>
            </div>

            <div className={s.platformStatusCard}>
              <div className={s.platformStatusHeader}>
                <span style={{ color: '#fca5a5' }}>🔴 Señal YouTube</span>
                <span className={s.charCount}>
                  {auth.youtubeAuthenticated
                    ? ytLive
                      ? 'EN VIVO'
                      : `CONECTADO (${auth.youtubeAuthMode === 'oauth' ? 'OAuth' : 'API Key'})`
                    : 'NO CONECTADO'}
                </span>
              </div>
              <div className={s.platformStatusDetail}>
                Canal: <strong>{auth.youtubeUser?.displayName || youtubeLogin || '—'}</strong>
              </div>
              <div className={s.platformStatusDetail}>
                Categoría: {ytData?.categoryName || ytInfo?.categoryName || 'Videojuegos (Gaming)'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
