import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocketEvent } from '../hooks/useSocket';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { apiGet, apiPost } from '../utils/api';
import type {
  KpiOverview,
  KpiVideoArchiveItem,
  ViewerSnapshot,
  GamePerformance,
  BestSlot,
  ChannelRaidEvent,
  TwitchTopGame,
  ChatStats,
  StreamSummary,
  ChannelRecord,
} from '@streamdaemon/shared';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from 'recharts';
import { EmptyState } from './EmptyState';
import { SkeletonCard, SkeletonChart } from './Skeletons';
import s from './KpiPanel.module.css';

type SubTab =
  | 'overview'
  | 'audience'
  | 'chat'
  | 'summary'
  | 'records'
  | 'games'
  | 'slots'
  | 'topGames';

type PlatformScope = 'multi' | 'twitch' | 'youtube';

interface Props {
  channel: string;
}

const DAY_NAMES: Record<number, string> = {
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
};

function formatNumber(n: number): string {
  if (!n || Number.isNaN(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('es-ES');
}

function formatCurrency(n: number): string {
  return (
    (n || 0).toLocaleString('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' €'
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function DeltaBadge({ value }: { value?: number }) {
  if (value === undefined) return null;
  const isPos = value > 0;
  const isNeg = value < 0;
  const cls = `${s.deltaBadge} ${
    isPos ? s.deltaPositive : isNeg ? s.deltaNegative : s.deltaNeutral
  }`;
  const arrow = isPos ? '↑' : isNeg ? '↓' : '—';
  const text = value === 0 ? '0%' : `${isPos ? '+' : ''}${value}%`;
  return (
    <span className={cls}>
      <span>{arrow}</span>
      <span>{text}</span>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. OVERVIEW TAB — Executive Multistream Summary & Recent Archives
   ═══════════════════════════════════════════════════════════════════════════ */
function OverviewTab({
  channel,
  platform,
  onInspectVideo,
}: {
  channel: string;
  platform: PlatformScope;
  onInspectVideo: (videoId: string) => void;
}) {
  const [data, setData] = useState<KpiOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [raids, setRaids] = useState<ChannelRaidEvent[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet(
        `/kpi/overview/${encodeURIComponent(channel)}?period=${period}&platform=${platform}`,
      );
      if (res.ok) {
        setData((await res.json()) as KpiOverview);
      }
    } catch {
      // Ignore fetch error
    } finally {
      setLoading(false);
    }
  }, [channel, period, platform]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useSocketEvent(
    'channel:raid',
    useCallback((e: ChannelRaidEvent) => {
      setRaids((prev) => [e, ...prev].slice(0, 12));
    }, []),
  );

  if (loading) {
    return (
      <div className={s.sectionContainer}>
        <SkeletonCard style={{ height: 46 }} />
        <div className={s.matrixGrid4}>
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} style={{ height: 108 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={s.emptyBox}>
        No se pudieron recuperar las métricas del período seleccionado. Verifica que tu canal de Twitch o YouTube esté conectado.
      </div>
    );
  }

  const tw = data.platformBreakdown?.twitch;
  const yt = data.platformBreakdown?.youtube;
  const archives = data.recentArchives || [];

  return (
    <div className={s.sectionContainer}>
      {/* Period Selector Toolbar */}
      <div className={s.toolbarBar}>
        <div className={s.toolbarGroup}>
          <span className={s.toolbarLabel}>Ventana temporal de análisis:</span>
          <div className={s.periodPills}>
            {(
              [
                { id: '7d', label: '7 días' },
                { id: '30d', label: '30 días' },
                { id: '90d', label: '90 días' },
                { id: 'all', label: 'Histórico total' },
              ] as const
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${s.periodBtn} ${period === p.id ? s.periodBtnActive : ''}`}
                onClick={() => setPeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className={s.actionBtn} onClick={fetchData}>
          ↻ Sincronizar estadísticas
        </button>
      </div>

      {/* 8-Cell Structural Telemetry Matrix */}
      <div className={s.matrixFrame}>
        <div className={s.matrixGrid4}>
          {/* 1. Total Community */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Comunidad total acumulada</span>
            </div>
            <div className={s.matrixValue}>{formatNumber(data.followers)}</div>
            <div className={s.matrixBreakdown}>
              {tw && (platform === 'multi' || platform === 'twitch') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  TW {formatNumber(tw.followers)} seg.
                </span>
              )}
              {yt && (platform === 'multi' || platform === 'youtube') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  YT {formatNumber(yt.subscribers)} suscr.
                </span>
              )}
            </div>
          </div>

          {/* 2. Period Views */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Visualizaciones en el período</span>
              {period !== 'all' && <DeltaBadge value={data.totalViewsDelta} />}
            </div>
            <div className={s.matrixValue}>{formatNumber(data.totalViews)}</div>
            <div className={s.matrixBreakdown}>
              {tw && (platform === 'multi' || platform === 'twitch') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  TW {formatNumber(tw.totalViews)}
                </span>
              )}
              {yt && (platform === 'multi' || platform === 'youtube') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  YT {formatNumber(yt.periodViews)}
                </span>
              )}
            </div>
          </div>

          {/* 3. Average Views / Viewers */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Media por emisión / vídeo</span>
              {period !== 'all' && <DeltaBadge value={data.avgViewersDelta} />}
            </div>
            <div className={s.matrixValue}>{formatNumber(data.avgViewers)}</div>
            <div className={s.matrixBreakdown}>
              {tw && (platform === 'multi' || platform === 'twitch') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  TW {formatNumber(tw.avgViewers)}
                </span>
              )}
              {yt && (platform === 'multi' || platform === 'youtube') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  YT {formatNumber(yt.avgViews)}
                </span>
              )}
            </div>
          </div>

          {/* 4. Peak Views / Viewers */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Pico máximo del período</span>
              {period !== 'all' && <DeltaBadge value={data.peakViewersDelta} />}
            </div>
            <div className={s.matrixValue}>{formatNumber(data.peakViewers)}</div>
            <div className={s.matrixBreakdown}>
              {tw && (platform === 'multi' || platform === 'twitch') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  TW {formatNumber(tw.peakViewers)}
                </span>
              )}
              {yt && (platform === 'multi' || platform === 'youtube') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  YT {formatNumber(yt.peakViews)}
                </span>
              )}
            </div>
          </div>

          {/* 5. YouTube Engagement (Likes + Comments + Ratio) */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Interacción en YouTube (Likes y Coment.)</span>
              {period !== 'all' && <DeltaBadge value={data.totalLikesDelta} />}
            </div>
            <div className={s.matrixValue}>
              {formatNumber((data.totalLikes || 0) + (data.totalComments || 0))}
            </div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                👍 {formatNumber(data.totalLikes || 0)}
              </span>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                💬 {formatNumber(data.totalComments || 0)}
              </span>
              {Boolean(data.engagementRate) && (
                <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                  {data.engagementRate}% eng.
                </span>
              )}
            </div>
          </div>

          {/* 6. Streams & Published Videos + Hours */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Emisiones y vídeos publicados</span>
              {period !== 'all' && <DeltaBadge value={data.streamsThisPeriodDelta} />}
            </div>
            <div className={s.matrixValue}>
              {data.streamsThisPeriod}{' '}
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text2)' }}>
                ({data.totalHoursStreamed}h)
              </span>
            </div>
            <div className={s.matrixBreakdown}>
              {tw && (platform === 'multi' || platform === 'twitch') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  TW {tw.streams} ({tw.hours}h)
                </span>
              )}
              {yt && (platform === 'multi' || platform === 'youtube') && (
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  YT {yt.videos} ({yt.hours}h)
                </span>
              )}
            </div>
          </div>

          {/* 7. Live Session Community Growth */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Altas en directo (Follows y Subs)</span>
              {period !== 'all' && <DeltaBadge value={data.followersGainedDelta} />}
            </div>
            <div className={s.matrixValue}>
              +{formatNumber(data.followersGained + data.subsGained)}
            </div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                +{data.followersGained} seg.
              </span>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                +{data.subsGained} subs/miembros
              </span>
            </div>
          </div>

          {/* 8. Estimated Live Revenue & Monetization */}
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Ingresos estimados en vivo</span>
              {period !== 'all' && <DeltaBadge value={data.estimatedRevenueDelta} />}
            </div>
            <div className={s.matrixValue}>{formatCurrency(data.estimatedRevenue)}</div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                💎 {formatNumber(data.bitsDonated)} pts (Bits / SuperChat)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Dual-Platform Comparison Ledger (When in Multistream view) */}
      {platform === 'multi' && (tw || yt) && (
        <section className={s.panelCard}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Comparativa de rendimiento por plataforma</span>
            <span className={s.panelSubtitle}>Desglose estructural Twitch vs YouTube Live</span>
          </div>
          <div className={s.comparisonGrid}>
            {/* Twitch Pane */}
            <div className={s.comparisonPane}>
              <div className={s.comparisonHeader}>
                <span style={{ color: '#c4b5fd' }}>🟣 Canal de Twitch</span>
                <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                  {tw?.streams ?? 0} emisiones en período
                </span>
              </div>
              <div className={s.comparisonStatsRow}>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Seguidores</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(tw?.followers ?? 0)}
                  </span>
                </div>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Suscriptores</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(tw?.subscribers ?? 0)}
                  </span>
                </div>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Vistas VOD</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(tw?.totalViews ?? 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* YouTube Pane */}
            <div className={s.comparisonPane}>
              <div className={s.comparisonHeader}>
                <span style={{ color: '#fca5a5' }}>🔴 Canal de YouTube</span>
                <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                  {formatNumber(yt?.totalChannelViews ?? 0)} vistas históricas del canal
                </span>
              </div>
              <div className={s.comparisonStatsRow}>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Suscriptores YT</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(yt?.subscribers ?? 0)}
                  </span>
                </div>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Likes período</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(yt?.periodLikes ?? 0)}
                  </span>
                </div>
                <div className={s.comparisonStatBox}>
                  <span className={s.comparisonStatLabel}>Vistas período</span>
                  <span className={s.comparisonStatValue}>
                    {formatNumber(yt?.periodViews ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Recent Streams & Videos Catalog (Twitch VODs + YouTube Uploads/Broadcasts) */}
      <section className={s.panelCard}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>
            Catálogo reciente de emisiones y vídeos ({archives.length})
          </span>
          <span className={s.panelSubtitle}>
            Haz clic en «Auditar» para abrir la ficha técnica completa de cualquier directo o vídeo
          </span>
        </div>

        {archives.length === 0 ? (
          <div className={s.emptyBox} style={{ border: 'none', borderRadius: 0 }}>
            No se encontraron emisiones o vídeos archivados en este período.
          </div>
        ) : (
          <div className={s.archiveList}>
            {archives.slice(0, 12).map((item: KpiVideoArchiveItem) => (
              <div key={`${item.platform}-${item.id}`} className={s.archiveRow}>
                <div className={s.archiveLeft}>
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt="" className={s.archiveThumb} />
                  ) : (
                    <div className={s.archiveThumb} />
                  )}
                  <div className={s.archiveMeta}>
                    <div className={s.archiveTitle}>{item.title}</div>
                    <div className={s.archiveSub}>
                      <span
                        className={`${s.miniPlatformTag} ${
                          item.platform === 'youtube' ? s.miniTagYoutube : s.miniTagTwitch
                        }`}
                      >
                        {item.platform === 'youtube' ? 'YT' : 'TW'}
                      </span>
                      <span>{item.categoryName}</span>
                      <span>· {new Date(item.publishedAt).toLocaleDateString('es-ES')}</span>
                      {item.durationSeconds > 0 && (
                        <span>· ⏱ {formatDuration(item.durationSeconds)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className={s.archiveMetrics}>
                  <span className={s.archiveStatPill} title="Visualizaciones">
                    👁 {formatNumber(item.views)}
                  </span>
                  {item.platform === 'youtube' && (
                    <>
                      <span className={s.archiveStatPill} title="Me gusta en YouTube">
                        👍 {formatNumber(item.likes || 0)}
                      </span>
                      <span className={s.archiveStatPill} title="Comentarios en YouTube">
                        💬 {formatNumber(item.comments || 0)}
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    className={s.actionBtn}
                    onClick={() => onInspectVideo(item.id)}
                  >
                    📊 Auditar
                  </button>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={s.actionBtn}
                  >
                    Abrir ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Live Raids if any */}
      {raids.length > 0 && (
        <section className={s.panelCard}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Raids recibidas en la sesión</span>
          </div>
          <div className={s.archiveList}>
            {raids.map((r, i) => (
              <div key={i} className={s.archiveRow}>
                <div className={s.archiveLeft}>
                  <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>RAID</span>
                  <span className={s.archiveTitle}>{r.fromDisplayName}</span>
                </div>
                <div className={s.archiveMetrics}>
                  <span className={s.archiveStatPill}>
                    👥 {formatNumber(r.viewerCount)} espectadores
                  </span>
                  <span className={s.archiveStatPill}>
                    {new Date(r.timestamp).toLocaleTimeString('es-ES')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. AUDIENCE TAB — Real-Time Multistream Telemetry & Engagement Curve
   ═══════════════════════════════════════════════════════════════════════════ */
function AudienceTab({
  channel,
  platform,
}: {
  channel: string;
  platform: PlatformScope;
}) {
  const [snapshots, setSnapshots] = useState<ViewerSnapshot[]>([]);
  const [activeViewers, setActiveViewers] = useState(0);
  const [twActive, setTwActive] = useState(0);
  const [ytActive, setYtActive] = useState(0);

  useEffect(() => {
    if (!channel) return;
    apiPost('/hud/start-poll', { channel, interval: 15 }).catch(() => {});
  }, [channel]);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await apiGet(`/kpi/viewers-history/${encodeURIComponent(channel)}`);
        if (res.ok) {
          const d = (await res.json()) as {
            snapshots: ViewerSnapshot[];
            activeViewers: number;
            twitchViewers?: number;
            youtubeViewers?: number;
          };
          setSnapshots(d.snapshots || []);
          setActiveViewers(d.activeViewers || 0);
          setTwActive(d.twitchViewers || 0);
          setYtActive(d.youtubeViewers || 0);
        }
      } catch {
        // Ignore poll error
      }
    };
    fetchHistory();
    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, [channel]);

  const chartData = useMemo(
    () =>
      snapshots.map((snap) => {
        const twV = snap.twitchViewers ?? snap.viewers;
        const ytV = snap.youtubeViewers ?? 0;
        const scopedViewers =
          platform === 'twitch' ? twV : platform === 'youtube' ? ytV : snap.viewers;
        return {
          time: new Date(snap.timestamp).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          totalViewers: scopedViewers,
          twitchViewers: twV,
          youtubeViewers: ytV,
          chatters: snap.chattersActive || 0,
          engagement:
            scopedViewers > 0
              ? Math.min(100, Math.round(((snap.chattersActive || 0) / scopedViewers) * 100))
              : 0,
        };
      }),
    [snapshots, platform],
  );

  const avgViewers =
    chartData.length > 0
      ? Math.round(chartData.reduce((acc, s) => acc + s.totalViewers, 0) / chartData.length)
      : 0;
  const peakViewers =
    chartData.length > 0 ? Math.max(...chartData.map((s) => s.totalViewers)) : 0;
  const avgEngagement =
    chartData.length > 0
      ? Math.round(chartData.reduce((acc, s) => acc + s.engagement, 0) / chartData.length)
      : 0;

  let trend = 0;
  if (chartData.length >= 4) {
    const recent = chartData.slice(-4);
    const oldest = recent[0].totalViewers;
    const newest = recent[recent.length - 1].totalViewers;
    trend = oldest > 0 ? Math.round(((newest - oldest) / oldest) * 100) : 0;
  }

  return (
    <div className={s.sectionContainer}>
      {/* 4-Column Live Telemetry Strip */}
      <div className={s.matrixFrame}>
        <div className={s.matrixGrid4}>
          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Espectadores activos ahora</span>
              <DeltaBadge value={trend} />
            </div>
            <div className={s.matrixValue}>{formatNumber(activeViewers)}</div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                TW {formatNumber(twActive)}
              </span>
              <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                YT {formatNumber(ytActive)}
              </span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Media de sesión en vivo</span>
            </div>
            <div className={s.matrixValue}>{formatNumber(avgViewers)}</div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>{snapshots.length} muestras registradas</span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Pico de la sesión actual</span>
            </div>
            <div className={s.matrixValue}>{formatNumber(peakViewers)}</div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>Máximo concurrente</span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <div className={s.matrixCellHeader}>
              <span className={s.matrixLabel}>Participación de audiencia</span>
            </div>
            <div className={s.matrixValue} style={{ color: '#10b981' }}>
              {avgEngagement}%
            </div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>Chatters activos / Espectadores</span>
            </div>
          </div>
        </div>
      </div>

      {/* Multi-Signal Line Chart */}
      <section className={s.panelCard}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>Curva de audiencia en tiempo real (Twitch + YouTube)</span>
          <span className={s.panelSubtitle}>Muestreo automático cada 15 segundos</span>
        </div>

        {chartData.length < 2 ? (
          <div className={s.emptyBox} style={{ border: 'none', borderRadius: 0 }}>
            Recopilando muestras de telemetría en vivo ({chartData.length}/2). La gráfica se dibujará automáticamente en unos segundos.
          </div>
        ) : (
          <div className={s.chartViewport}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255, 255, 255, 0.06)"
                  vertical={false}
                />
                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  fontSize={11}
                  tickMargin={8}
                  minTickGap={28}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#94a3b8"
                  fontSize={11}
                  tickFormatter={formatNumber}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#10b981"
                  fontSize={11}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0d0d14',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '12px',
                  }}
                />
                <Legend wrapperStyle={{ paddingTop: '8px', fontSize: '12px' }} />
                {platform === 'multi' && (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    name="Total Multistream"
                    dataKey="totalViewers"
                    stroke="#06b6d4"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                )}
                {(platform === 'multi' || platform === 'twitch') && (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    name="Señal Twitch"
                    dataKey="twitchViewers"
                    stroke="#9146ff"
                    strokeWidth={2}
                    dot={false}
                  />
                )}
                {(platform === 'multi' || platform === 'youtube') && (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    name="Señal YouTube"
                    dataKey="youtubeViewers"
                    stroke="#ff0033"
                    strokeWidth={2}
                    dot={false}
                  />
                )}
                <Line
                  yAxisId="right"
                  type="monotone"
                  name="Engagement %"
                  dataKey="engagement"
                  stroke="#10b981"
                  strokeWidth={1.8}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. CHAT STATS TAB — Multistream Chat Velocity & Top Chatters Leaderboard
   ═══════════════════════════════════════════════════════════════════════════ */
function ChatStatsTab({ channel }: { channel: string }) {
  const [stats, setStats] = useState<ChatStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchChatStats = useCallback(async () => {
    try {
      const res = await apiGet(`/kpi/chat-stats/${encodeURIComponent(channel)}`);
      if (res.ok) {
        setStats((await res.json()) as ChatStats);
      }
    } catch {
      // Ignore error
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    fetchChatStats();
    const timer = setInterval(fetchChatStats, 15000);
    return () => clearInterval(timer);
  }, [fetchChatStats]);

  if (loading) {
    return (
      <div className={s.sectionContainer}>
        <div className={s.matrixGrid4}>
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} style={{ height: 96 }} />
          ))}
        </div>
        <SkeletonChart height={300} />
      </div>
    );
  }

  if (!stats) {
    return <div className={s.emptyBox}>Esperando actividad de chat en Twitch o YouTube...</div>;
  }

  const chartData = stats.timeline.map((item) => ({
    time: new Date(item.timestamp).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    messagesPerMin: item.messagesPerMin,
    twitchMsgs: item.twitchMessagesPerMin ?? item.messagesPerMin,
    youtubeMsgs: item.youtubeMessagesPerMin ?? 0,
  }));

  const maxChatterCount = Math.max(
    ...(stats.topChatters?.map((c) => c.messageCount) || [1]),
    1,
  );

  return (
    <div className={s.sectionContainer}>
      {/* 4-Column Chat Telemetry Strip */}
      <div className={s.matrixFrame}>
        <div className={s.matrixGrid4}>
          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Velocidad media (Msgs / min)</span>
            <div className={s.matrixValue}>{stats.avgMessagesPerMin}</div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>Ritmo sostenido de conversación</span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Pico de velocidad (Msgs / min)</span>
            <div className={s.matrixValue}>{stats.peakMessagesPerMin}</div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>Minuto de mayor actividad</span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Mensajes totales en sesión</span>
            <div className={s.matrixValue}>{formatNumber(stats.totalMessages)}</div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagTwitch}`}>
                TW {formatNumber(stats.twitchMessages ?? 0)}
              </span>
              <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                YT {formatNumber(stats.youtubeMessages ?? 0)}
              </span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Participantes únicos</span>
            <div className={s.matrixValue} style={{ color: '#06b6d4' }}>
              {formatNumber(stats.uniqueChatters)}
            </div>
            <div className={s.matrixBreakdown}>
              <span className={s.panelSubtitle}>Usuarios activos en el chat</span>
            </div>
          </div>
        </div>
      </div>

      <div className={s.twoColAnalytics}>
        {/* Left: Messages per Minute Area Chart */}
        <section className={s.panelCard}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Cadencia de mensajes por minuto</span>
            <span className={s.panelSubtitle}>Twitch IRC + YouTube Live Chat</span>
          </div>
          {chartData.length < 2 ? (
            <div className={s.emptyBox} style={{ border: 'none', borderRadius: 0 }}>
              Esperando más muestras de chat para trazar la curva de velocidad...
            </div>
          ) : (
            <div className={s.chartViewport}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="kpiTwMsgs" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#9146ff" stopOpacity={0.55} />
                      <stop offset="95%" stopColor="#9146ff" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="kpiYtMsgs" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ff0033" stopOpacity={0.55} />
                      <stop offset="95%" stopColor="#ff0033" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255, 255, 255, 0.06)"
                    vertical={false}
                  />
                  <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} minTickGap={28} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0d0d14',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      borderRadius: '8px',
                      color: '#f8fafc',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ paddingTop: '8px', fontSize: '12px' }} />
                  <Area
                    type="monotone"
                    name="Twitch Msgs/min"
                    dataKey="twitchMsgs"
                    stroke="#9146ff"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#kpiTwMsgs)"
                  />
                  <Area
                    type="monotone"
                    name="YouTube Msgs/min"
                    dataKey="youtubeMsgs"
                    stroke="#ff0033"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#kpiYtMsgs)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Right: Top Chatters Leaderboard */}
        <section className={s.panelCard}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>Top participantes del chat</span>
            <span className={s.panelSubtitle}>Ranking en tiempo real</span>
          </div>

          {!stats.topChatters || stats.topChatters.length === 0 ? (
            <div className={s.emptyBox} style={{ border: 'none', borderRadius: 0 }}>
              Los usuarios más participativos de Twitch y YouTube aparecerán aquí conforme avance la sesión.
            </div>
          ) : (
            <div className={s.leaderboardList}>
              {stats.topChatters.map((chatter, idx) => (
                <div key={`${chatter.platform}-${chatter.user}`} className={s.leaderboardRow}>
                  <span className={s.rankNum}>#{idx + 1}</span>
                  <span
                    className={`${s.miniPlatformTag} ${
                      chatter.platform === 'youtube' ? s.miniTagYoutube : s.miniTagTwitch
                    }`}
                  >
                    {chatter.platform === 'youtube' ? 'YT' : 'TW'}
                  </span>
                  <span className={s.chatterName}>{chatter.user}</span>
                  <div className={s.chatterBarWrap}>
                    <div
                      className={s.chatterBarFill}
                      style={{
                        width: `${Math.max(8, (chatter.messageCount / maxChatterCount) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className={s.chatterCount}>{chatter.messageCount} msgs</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. STREAM & VIDEO SUMMARY TAB — Post-Stream Auditor (Twitch + YouTube)
   ═══════════════════════════════════════════════════════════════════════════ */
function StreamSummaryTab({
  channel,
  platform,
  selectedVideoId,
  onSelectVideoId,
}: {
  channel: string;
  platform: PlatformScope;
  selectedVideoId: string;
  onSelectVideoId: (id: string) => void;
}) {
  const [summary, setSummary] = useState<
    (StreamSummary & { archives?: KpiVideoArchiveItem[] }) | null
  >(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = new URLSearchParams({ platform });
    if (selectedVideoId) q.set('videoId', selectedVideoId);
    apiGet(`/kpi/stream-summary/${encodeURIComponent(channel)}?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setSummary(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel, platform, selectedVideoId]);

  if (loading) {
    return (
      <div className={s.sectionContainer}>
        <SkeletonCard style={{ height: 340 }} />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className={s.emptyBox}>
        No se encontraron emisiones o vídeos recientes para generar el informe técnico post-emisión.
      </div>
    );
  }

  const archives = summary.archives || [];
  const isYt = summary.platform === 'youtube';

  return (
    <div className={s.sectionContainer}>
      {/* Stream / Video Selector Toolbar */}
      <div className={s.toolbarBar}>
        <div className={s.toolbarGroup} style={{ flex: 1 }}>
          <span className={s.toolbarLabel}>Seleccionar emisión o vídeo archivado:</span>
          <select
            className={s.archiveSelect}
            value={summary.id || selectedVideoId}
            onChange={(e) => onSelectVideoId(e.target.value)}
          >
            {archives.map((a) => (
              <option key={`${a.platform}-${a.id}`} value={a.id}>
                [{a.platform === 'youtube' ? 'YT' : 'TW'}] {a.title.slice(0, 62)} (
                {new Date(a.publishedAt).toLocaleDateString('es-ES')})
              </option>
            ))}
          </select>
        </div>

        {summary.url && (
          <a
            href={summary.url}
            target="_blank"
            rel="noopener noreferrer"
            className={s.actionBtn}
          >
            Ver en {isYt ? 'YouTube' : 'Twitch'} ↗
          </a>
        )}
      </div>

      {/* Technical Report Frame */}
      <section className={s.panelCard}>
        <div className={s.summaryHero}>
          <div className={s.summaryHeroLeft}>
            {summary.thumbnailUrl && (
              <img src={summary.thumbnailUrl} alt="" className={s.summaryThumbLarge} />
            )}
            <div>
              <div className={s.summaryMetaRow}>
                <span
                  className={`${s.miniPlatformTag} ${
                    isYt ? s.miniTagYoutube : s.miniTagTwitch
                  }`}
                >
                  {isYt ? '🔴 YOUTUBE LIVE / VIDEO' : '🟣 TWITCH VOD'}
                </span>
                <span>{summary.gameName}</span>
                <span>· {new Date(summary.startedAt).toLocaleDateString('es-ES')}</span>
                <span>· Duración: {formatDuration(summary.duration)}</span>
              </div>
              <h3 className={s.summaryHeadline}>{summary.streamTitle}</h3>
              <div className={s.summaryMetaRow}>
                <span>Comparativa frente a la media histórica del canal:</span>
                <DeltaBadge value={summary.avgViewersVsAvg} />
              </div>
            </div>
          </div>
        </div>

        <div className={s.matrixGrid4}>
          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Visualizaciones / Pico</span>
            <div className={s.matrixValue}>{formatNumber(summary.peakViewers)}</div>
            <div className={s.matrixBreakdown}>
              <DeltaBadge value={summary.avgViewersVsAvg} />
              <span className={s.panelSubtitle}>vs media del canal</span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>
              {isYt ? 'Me gusta y Comentarios (YT)' : 'Duración de la emisión'}
            </span>
            <div className={s.matrixValue}>
              {isYt
                ? formatNumber((summary.likes || 0) + (summary.comments || 0))
                : formatDuration(summary.duration)}
            </div>
            <div className={s.matrixBreakdown}>
              {isYt ? (
                <>
                  <span className={`${s.miniPlatformTag} ${s.miniTagYoutube}`}>
                    👍 {formatNumber(summary.likes || 0)}
                  </span>
                  <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                    💬 {formatNumber(summary.comments || 0)}
                  </span>
                  <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                    {summary.avgEngagement}% eng.
                  </span>
                </>
              ) : (
                <DeltaBadge value={summary.durationVsAvg} />
              )}
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Altas registradas en directo</span>
            <div className={s.matrixValue}>
              +{formatNumber(summary.followersGained + summary.subsGained)}
            </div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                +{summary.followersGained} seg.
              </span>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                +{summary.subsGained} subs/miembros
              </span>
            </div>
          </div>

          <div className={s.matrixCell}>
            <span className={s.matrixLabel}>Ingresos estimados de la sesión</span>
            <div className={s.matrixValue}>{formatCurrency(summary.estimatedRevenue)}</div>
            <div className={s.matrixBreakdown}>
              <span className={`${s.miniPlatformTag} ${s.miniTagNeutral}`}>
                💎 {formatNumber(summary.bitsDonated)} pts
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. RECORDS TAB — Historical Milestones Across Twitch & YouTube
   ═══════════════════════════════════════════════════════════════════════════ */
function RecordsTab({
  channel,
  platform,
}: {
  channel: string;
  platform: PlatformScope;
}) {
  const [records, setRecords] = useState<ChannelRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiGet(`/kpi/records/${encodeURIComponent(channel)}?platform=${platform}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.records) setRecords(d.records);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel, platform]);

  if (loading) {
    return (
      <div className={s.recordsGrid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} style={{ height: 130 }} />
        ))}
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className={s.emptyBox}>
        No se encontraron récords históricos para el filtro seleccionado.
      </div>
    );
  }

  return (
    <div className={s.recordsGrid}>
      {records.map((r, i) => (
        <div
          key={i}
          className={`${s.recordCard} ${
            r.platform === 'youtube' ? s.recordCardYoutube : s.recordCardTwitch
          }`}
        >
          <div>
            <div className={s.recordTop}>
              <span className={s.matrixLabel}>
                {r.icon} {r.label}
              </span>
              <span
                className={`${s.miniPlatformTag} ${
                  r.platform === 'youtube' ? s.miniTagYoutube : s.miniTagTwitch
                }`}
              >
                {r.platform === 'youtube' ? 'YOUTUBE' : 'TWITCH'}
              </span>
            </div>
            <div className={s.recordValue}>{r.value}</div>
          </div>

          <div>
            {r.streamTitle && <div className={s.recordContext}>{r.streamTitle}</div>}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: '8px',
              }}
            >
              {r.date ? (
                <span className={s.panelSubtitle}>
                  {new Date(r.date).toLocaleDateString('es-ES')}
                </span>
              ) : (
                <span />
              )}
              {r.url && (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={s.actionBtn}
                >
                  Ver vídeo ↗
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. GAMES & CATEGORIES TAB — Performance by Twitch Game & YouTube Category
   ═══════════════════════════════════════════════════════════════════════════ */
function GamesTab({
  channel,
  platform,
}: {
  channel: string;
  platform: PlatformScope;
}) {
  const [games, setGames] = useState<GamePerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchGames = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoading(true);
      try {
        const res = await apiGet(
          `/kpi/game-performance/${encodeURIComponent(channel)}?platform=${platform}`,
        );
        if (res.ok) {
          const d = (await res.json()) as { games?: GamePerformance[] };
          setGames(d.games || []);
        }
      } catch {
        // Ignore error
      } finally {
        setLoading(false);
      }
    },
    [channel, platform],
  );

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiPost(
        `/kpi/game-performance/${encodeURIComponent(channel)}/refresh`,
        { platform },
      );
      if (res.ok) {
        const d = (await res.json()) as { games?: GamePerformance[] };
        setGames(d.games || []);
      }
    } catch {
      // Ignore error
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className={s.gamesGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} style={{ height: 170 }} />
        ))}
      </div>
    );
  }

  return (
    <div className={s.sectionContainer}>
      <div className={s.toolbarBar}>
        <span className={s.toolbarLabel}>
          Rendimiento agrupado por categoría de Twitch y categoría de vídeo de YouTube
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className={s.actionBtn}
        >
          {refreshing
            ? '⟳ Sincronizando...'
            : '↻ Recalcular desde VODs y vídeos de YouTube'}
        </button>
      </div>

      {games.length === 0 ? (
        <div className={s.emptyBox}>
          No hay datos de categorías o juegos registrados en este período.
        </div>
      ) : (
        <div className={s.gamesGrid}>
          {games.map((g) => {
            const isYt = g.platform === 'youtube';
            return (
              <div key={`${g.platform}-${g.gameName}`} className={s.gameCard}>
                <div className={s.gameCardHeader}>
                  {g.boxArtUrl && (
                    <img
                      src={g.boxArtUrl}
                      alt={g.gameName}
                      className={isYt ? s.gameCoverWide : s.gameCover}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                      }}
                    >
                      <span
                        className={`${s.miniPlatformTag} ${
                          isYt ? s.miniTagYoutube : s.miniTagTwitch
                        }`}
                      >
                        {isYt ? 'YOUTUBE' : 'TWITCH'}
                      </span>
                      <span className={s.panelSubtitle}>
                        {g.streamCount} {isYt ? 'vídeos/directos' : 'streams'}
                      </span>
                    </div>
                    <div className={s.gameName} style={{ marginTop: '4px' }}>
                      {g.gameName}
                    </div>
                  </div>
                </div>

                <div className={s.gameStatsMatrix}>
                  <div className={s.gameStatCell}>
                    <span className={s.gameStatLabel}>Media de vistas</span>
                    <span className={s.gameStatNumber}>{formatNumber(g.avgViewers)}</span>
                  </div>
                  <div className={s.gameStatCell}>
                    <span className={s.gameStatLabel}>Pico máximo</span>
                    <span className={s.gameStatNumber}>{formatNumber(g.maxViewers)}</span>
                  </div>
                  <div className={s.gameStatCell}>
                    <span className={s.gameStatLabel}>
                      {isYt ? 'Likes acumulados' : 'Nuevos seguidores'}
                    </span>
                    <span
                      className={s.gameStatNumber}
                      style={{ color: isYt ? '#fca5a5' : '#6ee7b7' }}
                    >
                      {isYt
                        ? `👍 ${formatNumber(g.totalLikes || 0)}`
                        : `+${formatNumber(g.followersGained)}`}
                    </span>
                  </div>
                  <div className={s.gameStatCell}>
                    <span className={s.gameStatLabel}>Duración media</span>
                    <span className={s.gameStatNumber}>{formatDuration(g.avgDuration)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. BEST SLOTS TAB — Optimal Broadcast & Upload Schedule Intelligence
   ═══════════════════════════════════════════════════════════════════════════ */
function SlotsTab({
  channel,
  platform,
}: {
  channel: string;
  platform: PlatformScope;
}) {
  const [slots, setSlots] = useState<BestSlot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiGet(`/kpi/best-slots/${encodeURIComponent(channel)}?period=all&platform=${platform}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.slots) setSlots(d.slots);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel, platform]);

  if (loading) {
    return (
      <div className={s.sectionContainer}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} style={{ height: 44 }} />
        ))}
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div className={s.emptyBox}>
        No hay suficientes emisiones o vídeos históricos para calcular el mapa de mejores horarios.
      </div>
    );
  }

  const maxAvg = Math.max(...slots.map((sl) => sl.avgViewers), 1);
  const topThree = slots.slice(0, 3);

  return (
    <div className={s.sectionContainer}>
      {/* Top 3 Prime Time Recommendations */}
      <div className={s.primeSlotsRow}>
        {topThree.map((sl, idx) => (
          <div key={idx} className={s.primeSlotCard}>
            <div>
              <span className={s.panelSubtitle}>#{idx + 1} Franja recomendada</span>
              <div className={s.gameName} style={{ marginTop: '3px' }}>
                {DAY_NAMES[sl.dayOfWeek] || `Día ${sl.dayOfWeek}`} ·{' '}
                {String(sl.hourStart).padStart(2, '0')}:00h
              </div>
              <span className={s.panelSubtitle}>{sl.streamCount} emisiones/vídeos</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className={s.matrixValue} style={{ fontSize: '20px', color: 'var(--cyan)' }}>
                {formatNumber(sl.avgViewers)}
              </div>
              <span className={s.panelSubtitle}>media vistas</span>
            </div>
          </div>
        ))}
      </div>

      {/* Full Slot Ranking */}
      <section className={s.panelCard}>
        <div className={s.panelHeader}>
          <span className={s.panelTitle}>Rendimiento histórico por franja horaria</span>
          <span className={s.panelSubtitle}>
            Calculado sobre tus directos de Twitch y publicaciones de YouTube
          </span>
        </div>

        <div className={s.slotList}>
          {slots.slice(0, 20).map((sl, i) => (
            <div key={i} className={s.slotRow}>
              <span className={s.slotDayTime}>
                {DAY_NAMES[sl.dayOfWeek] || sl.dayOfWeek} ·{' '}
                {String(sl.hourStart).padStart(2, '0')}:00h
              </span>
              <div className={s.slotTrack}>
                <div
                  className={s.slotFill}
                  style={{ width: `${Math.max(5, (sl.avgViewers / maxAvg) * 100)}%` }}
                />
              </div>
              <span className={s.slotMetric}>
                {formatNumber(sl.avgViewers)}{' '}
                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text3)' }}>
                  ({sl.streamCount})
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. GLOBAL RADAR TAB — Twitch Top Categories + YouTube Gaming Live Trends
   ═══════════════════════════════════════════════════════════════════════════ */
function TopGamesTab({ platform }: { platform: PlatformScope }) {
  const [games, setGames] = useState<TwitchTopGame[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiGet(`/kpi/top-twitch-games?platform=${platform}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.games) setGames(d.games);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [platform]);

  if (loading) {
    return (
      <div className={s.gamesGrid}>
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} style={{ height: 140 }} />
        ))}
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div className={s.emptyBox}>
        No se pudieron cargar las tendencias globales de Twitch o YouTube Gaming.
      </div>
    );
  }

  return (
    <div className={s.gamesGrid}>
      {games.map((g, index) => {
        const isYt = g.platform === 'youtube';
        return (
          <div key={g.id} className={s.gameCard}>
            <div className={s.gameCardHeader}>
              {g.boxArtUrl && (
                <img
                  src={g.boxArtUrl}
                  alt={g.name}
                  className={isYt ? s.gameCoverWide : s.gameCover}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '6px',
                  }}
                >
                  <span
                    className={`${s.miniPlatformTag} ${
                      isYt ? s.miniTagYoutube : s.miniTagTwitch
                    }`}
                  >
                    {isYt ? '🔴 TENDENCIA YT GAMING' : '🟣 TOP TWITCH'}
                  </span>
                  <span className={s.panelSubtitle}>#{index + 1}</span>
                </div>
                <div className={s.gameName} style={{ marginTop: '4px' }}>
                  {g.name}
                </div>
                {g.topChannelName && <div className={s.gameSub}>Canal: {g.topChannelName}</div>}
              </div>
            </div>

            <div className={s.gameStatsMatrix} style={{ gridTemplateColumns: '1fr' }}>
              <div className={s.gameStatCell} style={{ borderRight: 'none' }}>
                <span className={s.gameStatLabel}>
                  {isYt
                    ? 'Visualizaciones en tendencia (YouTube Gaming)'
                    : 'Espectadores estimados en directo (Top 100)'}
                </span>
                <span className={s.gameStatNumber} style={{ color: '#6ee7b7' }}>
                  {formatNumber(g.estimatedViewers)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN KPI PANEL CONTAINER
   ═══════════════════════════════════════════════════════════════════════════ */
export function KpiPanel({ channel }: Props) {
  const auth = useAuthStatus();
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [platformScope, setPlatformScope] = useState<PlatformScope>('multi');
  const [selectedVideoId, setSelectedVideoId] = useState<string>('');

  const twitchLogin = auth.twitchUser?.login || (auth.twitchAuthenticated ? channel : '') || '';
  const youtubeLogin = auth.youtubeUser?.login || '';
  const effectiveChannel = channel || twitchLogin || youtubeLogin;

  const initializedScope = useRef(false);
  useEffect(() => {
    if (auth.loading || initializedScope.current) return;
    initializedScope.current = true;
    if (auth.twitchAuthenticated && auth.youtubeAuthenticated) {
      setPlatformScope('multi');
    } else if (auth.youtubeAuthenticated && !auth.twitchAuthenticated) {
      setPlatformScope('youtube');
    } else {
      setPlatformScope('multi');
    }
  }, [auth.loading, auth.twitchAuthenticated, auth.youtubeAuthenticated]);

  if (!effectiveChannel) {
    return (
      <EmptyState
        icon="📊"
        title="Sin canal vinculado para Estadísticas"
        description="Conecta tu cuenta de Twitch o tu canal de YouTube Live en Configuración para desbloquear la analítica avanzada y telemetría."
      />
    );
  }

  const subTabs: { id: SubTab; label: string }[] = [
    { id: 'overview', label: 'Resumen ejecutivo' },
    { id: 'audience', label: 'Audiencia en vivo' },
    { id: 'chat', label: 'Analítica de chat' },
    { id: 'summary', label: 'Informe de emisiones y vídeos' },
    { id: 'records', label: 'Récords e hitos' },
    { id: 'games', label: 'Por categoría y juego' },
    { id: 'slots', label: 'Mejores horarios' },
    { id: 'topGames', label: 'Radar global de tendencias' },
  ];

  const handleInspectVideo = (videoId: string) => {
    setSelectedVideoId(videoId);
    setSubTab('summary');
  };

  return (
    <div className={s.kpiRoot}>
      {/* Top Command Deck */}
      <header className={s.commandDeck}>
        <div className={s.commandTopRow}>
          <div className={s.headerIdentity}>
            <span className={s.suiteTitle}>Centro de inteligencia y analítica de emisión</span>
            <div className={s.channelBadges}>
              <span
                className={`${s.platformPill} ${
                  auth.twitchAuthenticated ? s.platformPillTwitch : ''
                }`}
              >
                🟣 TW: {auth.twitchUser?.displayName || twitchLogin || 'No conectado'}
              </span>
              <span
                className={`${s.platformPill} ${
                  auth.youtubeAuthenticated ? s.platformPillYoutube : ''
                }`}
              >
                🔴 YT: {auth.youtubeUser?.displayName || youtubeLogin || 'No conectado'}
              </span>
            </div>
          </div>

          {/* Global Platform Filter Switcher */}
          <div className={s.scopeSwitcher} role="tablist" aria-label="Filtro de plataforma">
            <button
              type="button"
              className={`${s.scopeBtn} ${
                platformScope === 'multi' ? s.scopeBtnMultiActive : ''
              }`}
              onClick={() => setPlatformScope('multi')}
            >
              ⚡ Multistream (Global)
            </button>
            <button
              type="button"
              className={`${s.scopeBtn} ${
                platformScope === 'twitch' ? s.scopeBtnTwitchActive : ''
              }`}
              onClick={() => setPlatformScope('twitch')}
            >
              🟣 Solo Twitch
            </button>
            <button
              type="button"
              className={`${s.scopeBtn} ${
                platformScope === 'youtube' ? s.scopeBtnYoutubeActive : ''
              }`}
              onClick={() => setPlatformScope('youtube')}
            >
              🔴 Solo YouTube
            </button>
          </div>
        </div>

        {/* 8 Subsections Navigation Bar */}
        <nav className={s.subNavStrip} aria-label="Subsecciones de estadísticas">
          {subTabs.map((st) => (
            <button
              key={st.id}
              type="button"
              className={`${s.subNavBtn} ${subTab === st.id ? s.subNavBtnActive : ''}`}
              onClick={() => setSubTab(st.id)}
            >
              {st.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Active Subsection Content */}
      {subTab === 'overview' && (
        <OverviewTab
          channel={effectiveChannel}
          platform={platformScope}
          onInspectVideo={handleInspectVideo}
        />
      )}
      {subTab === 'audience' && (
        <AudienceTab channel={effectiveChannel} platform={platformScope} />
      )}
      {subTab === 'chat' && <ChatStatsTab channel={effectiveChannel} />}
      {subTab === 'summary' && (
        <StreamSummaryTab
          channel={effectiveChannel}
          platform={platformScope}
          selectedVideoId={selectedVideoId}
          onSelectVideoId={setSelectedVideoId}
        />
      )}
      {subTab === 'records' && (
        <RecordsTab channel={effectiveChannel} platform={platformScope} />
      )}
      {subTab === 'games' && (
        <GamesTab channel={effectiveChannel} platform={platformScope} />
      )}
      {subTab === 'slots' && (
        <SlotsTab channel={effectiveChannel} platform={platformScope} />
      )}
      {subTab === 'topGames' && <TopGamesTab platform={platformScope} />}
    </div>
  );
}

export default KpiPanel;
