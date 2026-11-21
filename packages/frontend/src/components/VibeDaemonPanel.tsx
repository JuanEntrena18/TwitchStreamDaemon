import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiGet, apiPut, apiPost, OVERLAY_BASE_URL } from '../utils/api';
import { useSocket, useSocketEvent } from '../hooks/useSocket';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { Toggle } from './Toggle';
import type {
  VibeDaemonConfig,
  VibeDaemonTrigger,
  VibeDaemonState,
  VibeDaemonEvent,
  VibeDaemonActivation,
  VibeDaemonEventType,
  VibeDaemonGameId,
  VibeDaemonActionType,
  VibeDaemonConditionType,
  VibeDaemonResetPeriod,
  VibeDaemonCondition,
  VibeDaemonAction,
} from '@streamdaemon/shared';
import styles from './VibeDaemonPanel.module.css';
import { VibeCvSection } from './VibeCvSection';

interface Props {
  channel: string;
}

type HotkeySlot = 'kill' | 'death' | 'victory';

const EVENT_TYPES: VibeDaemonEventType[] = [
  'kill',
  'death',
  'victory',
  'kill_streak',
  'victory_streak',
  'low_health',
  'low_shield',
  'storm_shrinking',
  'manual',
];

const EVENT_META: Record<
  VibeDaemonEventType,
  { label: string; icon: string; color: string }
> = {
  kill: { label: 'Eliminación (+1 Kill)', icon: '🔥', color: '#ff6b00' },
  death: { label: 'Muerte / Eliminado', icon: '💀', color: '#ff3366' },
  victory: { label: '¡Victoria Magistral!', icon: '👑', color: '#ffd600' },
  kill_streak: { label: 'Racha de eliminaciones', icon: '⚡', color: '#c084fc' },
  victory_streak: { label: 'Racha de victorias', icon: '🏆', color: '#22c55e' },
  low_shield: { label: 'Escudo crítico (HUD)', icon: '🛡️', color: '#00d8ff' },
  low_health: { label: 'Vida crítica (HUD)', icon: '🩸', color: '#ff3366' },
  storm_shrinking: { label: 'Tormenta cerrándose (HUD)', icon: '🌀', color: '#a855f7' },
  manual: { label: 'Alerta manual', icon: '✨', color: '#38bdf8' },
};

const CONDITION_LABELS: Record<VibeDaemonConditionType, string> = {
  count: 'Cada N eventos',
  threshold: 'Al superar umbral',
  state: 'Detección de estado (HUD)',
};

const PERIOD_LABELS: Record<VibeDaemonResetPeriod, string> = {
  session: 'Sesión completa',
  match: 'Partida actual',
  round: 'Ronda actual',
  time_window: 'Ventana de tiempo',
};

const ACTION_LABELS: Record<VibeDaemonActionType, string> = {
  overlay: '🎬 Alerta Cartoon en OBS',
  media: '📹 Vídeo / GIF + Texto',
  sound: '🔊 Efecto de sonido',
  chat: '💬 Mensaje en chat',
  tts: '🗣️ Leer en voz alta (TTS)',
};

const HOTKEY_SLOT_LABELS: Record<HotkeySlot, { title: string; icon: string; safeDefault: string }> = {
  kill: { title: 'Registrar Eliminación (+1 Kill)', icon: '🔥', safeDefault: 'CommandOrControl+Shift+K' },
  death: { title: 'Registrar Muerte (+1 Death)', icon: '💀', safeDefault: 'CommandOrControl+Shift+D' },
  victory: { title: 'Registrar ¡Victoria Magistral!', icon: '👑', safeDefault: 'CommandOrControl+Shift+V' },
};

// Complete registry of StreamDaemon software shortcuts to detect conflicts proactively
const SOFTWARE_RESERVED_SHORTCUTS: Array<{ accel: string; label: string }> = [
  { accel: 'CommandOrControl+Shift+T', label: 'Overlay transparente (Click-Through global)' },
  { accel: 'CommandOrControl+K', label: 'Paleta de comandos rápida (Command Palette)' },
  { accel: 'CommandOrControl+1', label: 'Navegación rápida · Gestor de Stream' },
  { accel: 'CommandOrControl+2', label: 'Navegación rápida · Estadísticas / Tracker' },
  { accel: 'CommandOrControl+3', label: 'Navegación rápida · Panel 3' },
  { accel: 'CommandOrControl+4', label: 'Navegación rápida · Chat' },
  { accel: 'CommandOrControl+5', label: 'Navegación rápida · Seguridad Anti-Bots' },
  { accel: 'CommandOrControl+6', label: 'Navegación rápida · Moderación' },
  { accel: 'CommandOrControl+7', label: 'Navegación rápida · Comandos' },
  { accel: 'CommandOrControl+8', label: 'Navegación rápida · Overlays OBS' },
  { accel: 'CommandOrControl+9', label: 'Navegación rápida · Subathon' },
  { accel: 'Space', label: 'Cronómetro de Speedrun (Iniciar / Split)' },
  { accel: 'R', label: 'Cronómetro de Speedrun (Reiniciar)' },
];

function normalizeAccel(accel: string): string {
  return accel
    .trim()
    .toLowerCase()
    .replace(/\bctrl\b/g, 'commandorcontrol')
    .replace(/\bcmdorctrl\b/g, 'commandorcontrol')
    .replace(/\s+/g, '');
}

function formatAccelDisplay(accel?: string): string {
  if (!accel) return 'Sin asignar';
  return accel.replace(/CommandOrControl/g, 'Ctrl');
}

function keyEventToElectronAccelerator(e: KeyboardEvent): string | null {
  const key = e.key;
  if (
    key === 'Control' ||
    key === 'Shift' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'Dead'
  ) {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let mainKey = key;
  if (key === ' ') mainKey = 'Space';
  else if (key === 'ArrowUp') mainKey = 'Up';
  else if (key === 'ArrowDown') mainKey = 'Down';
  else if (key === 'ArrowLeft') mainKey = 'Left';
  else if (key === 'ArrowRight') mainKey = 'Right';
  else if (key.length === 1) mainKey = key.toUpperCase();

  parts.push(mainKey);
  return parts.join('+');
}

function numVal(v: string | undefined): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

interface TriggerEditorProps {
  trigger: VibeDaemonTrigger;
  onPatch: (patch: Partial<VibeDaemonTrigger>) => void;
  onPatchCondition: (patch: Partial<VibeDaemonCondition>) => void;
  onPatchAction: (patch: Partial<VibeDaemonAction>) => void;
  onDelete: () => void;
  onTest: () => void;
}

function TriggerEditor({
  trigger,
  onPatch,
  onPatchCondition,
  onPatchAction,
  onDelete,
  onTest,
}: TriggerEditorProps) {
  const condition = trigger.condition;
  const action = trigger.action;
  const meta = EVENT_META[trigger.eventType] ?? EVENT_META.manual;
  const showsThreshold = condition.type === 'count' || condition.type === 'threshold';
  const showsPeriod = condition.type !== 'state';

  return (
    <div className={styles.daemonCard}>
      <div className={styles.daemonRibbon} style={{ background: meta.color }} />
      <div className={styles.daemonBody}>
        <div className={styles.daemonHeader}>
          <span className={styles.eventEmojiBadge} title={meta.label}>
            {meta.icon}
          </span>
          <input
            className={styles.daemonNameInput}
            value={trigger.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="Nombre de la alerta..."
          />
          <Toggle
            size="sm"
            checked={trigger.enabled}
            onChange={(enabled) => onPatch({ enabled })}
          />
          <button
            type="button"
            className={`${styles.comicBtn} ${styles.comicBtnCyan} ${styles.comicBtnSm}`}
            onClick={onTest}
            title="Disparar esta alerta ahora mismo en el overlay de OBS"
          >
            ▶ Probar
          </button>
          <button
            type="button"
            className={`${styles.comicBtn} ${styles.comicBtnRed} ${styles.comicBtnSm}`}
            onClick={onDelete}
            title="Eliminar regla"
          >
            🗑
          </button>
        </div>

        <div className={styles.configGrid}>
          <div>
            <label className={styles.fieldLabel}>Evento disparador</label>
            <select
              className={styles.fieldInput}
              value={trigger.eventType}
              onChange={(e) => onPatch({ eventType: e.target.value as VibeDaemonEventType })}
            >
              {EVENT_TYPES.map((et) => (
                <option key={et} value={et}>
                  {EVENT_META[et].icon} {EVENT_META[et].label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={styles.fieldLabel}>Condición</label>
            <select
              className={styles.fieldInput}
              value={condition.type}
              onChange={(e) =>
                onPatchCondition({ type: e.target.value as VibeDaemonConditionType })
              }
            >
              {(['count', 'threshold', 'state'] as const).map((ct) => (
                <option key={ct} value={ct}>
                  {CONDITION_LABELS[ct]}
                </option>
              ))}
            </select>
          </div>

          {showsThreshold && (
            <div>
              <label className={styles.fieldLabel}>Cantidad / Umbral</label>
              <input
                type="number"
                min={1}
                className={styles.fieldInput}
                value={
                  condition.type === 'threshold' ? condition.threshold ?? 1 : condition.count ?? 1
                }
                onChange={(e) => {
                  const value = Math.max(1, numVal(e.target.value));
                  onPatchCondition(
                    condition.type === 'threshold' ? { threshold: value } : { count: value },
                  );
                }}
              />
            </div>
          )}

          {showsPeriod && (
            <div>
              <label className={styles.fieldLabel}>Reinicio contador</label>
              <select
                className={styles.fieldInput}
                value={condition.period ?? 'session'}
                onChange={(e) =>
                  onPatchCondition({ period: e.target.value as VibeDaemonResetPeriod })
                }
              >
                {(['session', 'match', 'round', 'time_window'] as const).map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
          )}

          {condition.period === 'time_window' && (
            <div>
              <label className={styles.fieldLabel}>Ventana (seg)</label>
              <input
                type="number"
                min={1}
                className={styles.fieldInput}
                value={condition.timeWindowSeconds ?? 60}
                onChange={(e) =>
                  onPatchCondition({ timeWindowSeconds: Math.max(1, numVal(e.target.value)) })
                }
              />
            </div>
          )}

          <div>
            <label className={styles.fieldLabel}>Cooldown (ms)</label>
            <input
              type="number"
              min={0}
              step={500}
              className={styles.fieldInput}
              value={trigger.cooldownMs ?? 0}
              onChange={(e) => onPatch({ cooldownMs: Math.max(0, numVal(e.target.value)) })}
            />
          </div>

          <div>
            <label className={styles.fieldLabel}>Acción</label>
            <select
              className={styles.fieldInput}
              value={action.type}
              onChange={(e) => onPatchAction({ type: e.target.value as VibeDaemonActionType })}
            >
              {(['overlay', 'media', 'sound', 'chat', 'tts'] as const).map((at) => (
                <option key={at} value={at}>
                  {ACTION_LABELS[at]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={styles.fieldLabel}>Duración (ms)</label>
            <input
              type="number"
              min={500}
              max={60000}
              step={500}
              className={styles.fieldInput}
              value={action.durationMs ?? 3000}
              onChange={(e) =>
                onPatchAction({ durationMs: Math.max(500, numVal(e.target.value)) })
              }
            />
          </div>

          {action.type === 'media' && (
            <div className={styles.fullRow}>
              <label className={styles.fieldLabel}>URL del vídeo (.webm/.mp4) o GIF</label>
              <input
                className={styles.fieldInput}
                value={action.mediaUrl ?? ''}
                placeholder="https://.../victory.webm"
                onChange={(e) => onPatchAction({ mediaUrl: e.target.value })}
              />
            </div>
          )}

          {(action.type === 'sound' || action.type === 'overlay' || action.type === 'media') && (
            <>
              <div className={styles.fullRow}>
                <label className={styles.fieldLabel}>
                  URL de sonido opcional (.mp3 / .wav)
                </label>
                <input
                  className={styles.fieldInput}
                  value={action.soundUrl ?? ''}
                  placeholder="Opcional: https://.../elimination.mp3"
                  onChange={(e) => onPatchAction({ soundUrl: e.target.value })}
                />
              </div>
              {action.soundUrl && (
                <div>
                  <label className={styles.fieldLabel}>
                    Volumen ({Math.round((action.volume ?? 0.7) * 100)}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    className={styles.fieldInput}
                    value={action.volume ?? 0.7}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      onPatchAction({ volume: Number.isFinite(val) ? val : 0.7 });
                    }}
                  />
                </div>
              )}
            </>
          )}

          <div className={styles.fullRow}>
            <label className={styles.fieldLabel}>
              Texto de la alerta (variables: {'{{kills}}'}, {'{{killStreak}}'}, {'{{victories}}'})
            </label>
            <input
              className={styles.fieldInput}
              value={action.message ?? ''}
              placeholder="Ej: ¡ELIMINACIÓN! ({{kills}} KILLS)"
              onChange={(e) => onPatchAction({ message: e.target.value })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function VibeDaemonPanel({ channel }: Props) {
  const { socket, connected } = useSocket();
  const auth = useAuthStatus();
  const effectiveChannel =
    channel || auth.twitchUser?.login || auth.youtubeUser?.login || 'global';

  const [config, setConfig] = useState<VibeDaemonConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [state, setState] = useState<VibeDaemonState | null>(null);
  const [lastActivation, setLastActivation] = useState<string | null>(null);
  const [copied, setCopied] = useState<'live' | 'demo' | null>(null);

  // Add new trigger form
  const [newGameId, setNewGameId] = useState<string>('fortnite');
  const [newGameCustom, setNewGameCustom] = useState('');
  const [newName, setNewName] = useState('');
  const [newEventType, setNewEventType] = useState<VibeDaemonEventType>('kill');

  // Hotkey recorder & live OS registration status
  const [recordingSlot, setRecordingSlot] = useState<HotkeySlot | null>(null);
  const [osHotkeyStatus, setOsHotkeyStatus] = useState<
    Record<string, { accelerator: string; ok: boolean; error?: string }>
  >({});

  useEffect(() => {
    if (effectiveChannel && connected) {
      socket.emit('join:channel', effectiveChannel.toLowerCase());
      socket.emit('join:channel', 'global');
    }
  }, [effectiveChannel, connected, socket]);

  useEffect(() => {
    apiGet('/vibe-daemon/config')
      .then((r) => r.json())
      .then((data: VibeDaemonConfig) => setConfig(data))
      .catch(() => {});

    window.streamforger?.vibeHotkeys
      ?.getStatus()
      .then((res) => setOsHotkeyStatus(res.registered || {}))
      .catch(() => {});
  }, []);

  const refreshState = useCallback(() => {
    if (!effectiveChannel) return;
    apiGet(`/vibe-daemon/state/${encodeURIComponent(effectiveChannel)}`)
      .then((r) => r.json())
      .then((data: VibeDaemonState) => setState(data))
      .catch(() => {});
  }, [effectiveChannel]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useSocketEvent(
    'vibe-daemon:state',
    useCallback((data: VibeDaemonState) => {
      if (data) setState(data);
    }, []),
  );

  useSocketEvent(
    'vibe-daemon:activation',
    useCallback((data: VibeDaemonActivation) => {
      if (data) setLastActivation(data.action?.message || data.triggerName);
    }, []),
  );

  const mutate = useCallback((updater: (cfg: VibeDaemonConfig) => VibeDaemonConfig) => {
    setConfig((c) => (c ? updater(c) : c));
    setDirty(true);
    setSavedFlash(false);
  }, []);

  // Global keydown listener while recording a custom hotkey
  useEffect(() => {
    if (!recordingSlot) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingSlot(null);
        return;
      }
      const accel = keyEventToElectronAccelerator(e);
      if (!accel) return;
      mutate((cfg) => ({
        ...cfg,
        hotkeys: { ...(cfg.hotkeys ?? {}), [recordingSlot]: accel },
      }));
      setRecordingSlot(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recordingSlot, mutate]);

  // Compute hotkey conflicts against ALL StreamDaemon shortcuts + duplicates + OS status
  const hotkeyConflicts = useMemo(() => {
    const map: Record<HotkeySlot, string[]> = { kill: [], death: [], victory: [] };
    const hk = config?.hotkeys ?? {};
    const slots: HotkeySlot[] = ['kill', 'death', 'victory'];

    for (const slot of slots) {
      const accel = hk[slot];
      if (!accel) continue;
      const norm = normalizeAccel(accel);

      // 1. Check against reserved software shortcuts
      const reservedMatch = SOFTWARE_RESERVED_SHORTCUTS.find(
        (item) => normalizeAccel(item.accel) === norm,
      );
      if (reservedMatch) {
        map[slot].push(`Coincide con un atajo del software: ${reservedMatch.label}`);
      }

      // 2. Check duplicate within Vibe Daemon itself
      for (const other of slots) {
        if (other !== slot && hk[other] && normalizeAccel(hk[other]!) === norm) {
          map[slot].push(`Duplicado con «${HOTKEY_SLOT_LABELS[other].title}»`);
        }
      }

      // 3. Check OS registration error from Electron (if already saved)
      const osInfo = osHotkeyStatus[slot];
      if (osInfo && normalizeAccel(osInfo.accelerator) === norm && !osInfo.ok && osInfo.error) {
        if (!map[slot].some((msg) => msg.includes(osInfo.error!))) {
          map[slot].push(osInfo.error);
        }
      }
    }

    return map;
  }, [config?.hotkeys, osHotkeyStatus]);

  const totalConflicts =
    hotkeyConflicts.kill.length + hotkeyConflicts.death.length + hotkeyConflicts.victory.length;

  const patchTrigger = useCallback(
    (id: string, patch: Partial<VibeDaemonTrigger>) => {
      mutate((cfg) => ({
        ...cfg,
        triggers: cfg.triggers.map((tr) => (tr.id === id ? { ...tr, ...patch } : tr)),
      }));
    },
    [mutate],
  );

  const patchCondition = useCallback(
    (id: string, patch: Partial<VibeDaemonCondition>) => {
      mutate((cfg) => ({
        ...cfg,
        triggers: cfg.triggers.map((tr) =>
          tr.id === id ? { ...tr, condition: { ...tr.condition, ...patch } } : tr,
        ),
      }));
    },
    [mutate],
  );

  const patchAction = useCallback(
    (id: string, patch: Partial<VibeDaemonAction>) => {
      mutate((cfg) => ({
        ...cfg,
        triggers: cfg.triggers.map((tr) =>
          tr.id === id ? { ...tr, action: { ...tr.action, ...patch } } : tr,
        ),
      }));
    },
    [mutate],
  );

  const deleteTrigger = useCallback(
    (id: string) => {
      mutate((cfg) => ({ ...cfg, triggers: cfg.triggers.filter((tr) => tr.id !== id) }));
    },
    [mutate],
  );

  const addTrigger = useCallback(() => {
    const gameId: VibeDaemonGameId =
      (newGameId === 'custom' ? newGameCustom.trim().toLowerCase() : newGameId) || 'fortnite';
    const cleanName = newName.trim() || EVENT_META[newEventType].label;
    const isStateEvent =
      newEventType === 'low_shield' ||
      newEventType === 'low_health' ||
      newEventType === 'storm_shrinking';

    const trigger: VibeDaemonTrigger = {
      id: `vd-${gameId}-${Date.now().toString(36)}`,
      gameId,
      name: cleanName,
      enabled: true,
      eventType: newEventType,
      condition: isStateEvent
        ? { type: 'state' }
        : { type: 'count', count: 1, period: 'session' },
      action: {
        type: 'overlay',
        overlayId: 'vibe-daemon',
        durationMs: 3500,
        message: cleanName,
      },
      cooldownMs: isStateEvent ? 15000 : 0,
    };
    mutate((cfg) => ({ ...cfg, triggers: [...cfg.triggers, trigger] }));
    setNewName('');
    setNewGameCustom('');
  }, [newGameId, newGameCustom, newName, newEventType, mutate]);

  const save = useCallback(async () => {
    if (!config) return;
    const res = await apiPut('/vibe-daemon/config', config);
    if (res.ok) {
      setDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      // Immediately re-register global hotkeys in Electron (no 60s wait!)
      window.streamforger?.vibeHotkeys
        ?.reload()
        .then((statusRes) => setOsHotkeyStatus(statusRes.registered || {}))
        .catch(() => {});
    }
  }, [config]);

  const testTrigger = useCallback(
    (trigger: VibeDaemonTrigger) => {
      apiPost('/vibe-daemon/test', {
        channel: effectiveChannel,
        eventType: trigger.eventType,
        gameId: trigger.gameId,
        triggerId: trigger.id,
      }).catch(() => {});
    },
    [effectiveChannel],
  );

  const sendEvent = useCallback(
    (eventType: VibeDaemonEventType) => {
      const event: VibeDaemonEvent = {
        channel: effectiveChannel,
        gameId: 'fortnite',
        eventType,
        timestamp: Date.now(),
      };
      apiPost('/vibe-daemon/event', event).catch(() => {});
    },
    [effectiveChannel],
  );

  const resetSession = useCallback(() => {
    apiPost(`/vibe-daemon/reset/${encodeURIComponent(effectiveChannel)}`, { gameId: 'fortnite' })
      .then(() => refreshState())
      .catch(() => {});
  }, [effectiveChannel, refreshState]);

  const overlayUrl = `${OVERLAY_BASE_URL}/overlays/vibe-daemon.html?channel=${encodeURIComponent(effectiveChannel)}`;
  const demoUrl = `${overlayUrl}&demo=true`;

  const copyUrl = useCallback(
    (kind: 'live' | 'demo') => {
      const target = kind === 'demo' ? demoUrl : overlayUrl;
      navigator.clipboard
        ?.writeText(target)
        .then(() => {
          setCopied(kind);
          setTimeout(() => setCopied(null), 1800);
        })
        .catch(() => {});
    },
    [overlayUrl, demoUrl],
  );

  const hotkeys = config?.hotkeys ?? {};

  return (
    <div className={styles.container}>
      {/* ═══════════════════════════════════════════════════════════════════
          1. FORTNITE CARTOON HERO COMMAND BANNER
         ═══════════════════════════════════════════════════════════════════ */}
      <header className={styles.heroBanner}>
        <div className={styles.heroTopRow}>
          <div className={styles.heroTitleGroup}>
            <div className={styles.comicTagRow}>
              <span className={styles.comicBadge}>
                <span>🪂 FORTNITE EDITION</span>
              </span>
              <span className={`${styles.comicBadge} ${styles.comicBadgeCyan}`}>
                <span>⚡ ALERTAS AUTOMÁTICAS</span>
              </span>
              <span className={`${styles.comicBadge} ${styles.comicBadgePurple}`}>
                <span>🎨 ESTILO CARTOON</span>
              </span>
            </div>
            <h2 className={styles.heroTitle}>VIBE DAEMONS · CENTRAL DE ALERTAS</h2>
            <p className={styles.heroSubtitle}>
              Automatiza alertas cartoon en pantalla al detectar tu escudo, vida o tormenta en Fortnite, o
              dispara rachas de eliminaciones y victorias con tus atajos de teclado personalizados.
            </p>
          </div>

          {config && (
            <div className={styles.heroActions}>
              <Toggle
                size="sm"
                checked={config.enabled}
                label={config.enabled ? 'Motor ACTIVO' : 'Motor en pausa'}
                onChange={(enabled) => mutate((cfg) => ({ ...cfg, enabled }))}
              />
              {dirty && <span className={styles.dirtyBadge}>● Cambios sin guardar</span>}
              {savedFlash && <span className={styles.savedFlash}>✓ ¡Guardado y sincronizado!</span>}
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnYellow}`}
                onClick={save}
                disabled={!dirty}
              >
                💾 Guardar configuración
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ═══════════════════════════════════════════════════════════════════
          2. LIVE SCOREBOARD + INTERACTIVE HOTKEY CUSTOMIZER (2-COLUMN)
         ═══════════════════════════════════════════════════════════════════ */}
      <div className={styles.twoColGrid}>
        {/* Left: Fortnite Live Session Scoreboard & Manual Triggers */}
        <section className={styles.comicPanel}>
          <div className={styles.comicPanelHeader}>
            <div className={styles.panelHeading}>
              <span>🏆</span>
              <span>Marcador de partida en vivo</span>
            </div>
            <button
              type="button"
              className={`${styles.comicBtn} ${styles.comicBtnDark} ${styles.comicBtnSm}`}
              onClick={resetSession}
            >
              🔄 Reiniciar
            </button>
          </div>

          <div className={styles.comicPanelBody}>
            <div className={styles.stateGrid}>
              <div className={styles.statBox}>
                <div className={styles.statValue} style={{ color: '#ff8a3d' }}>
                  {state?.kills ?? 0}
                </div>
                <div className={styles.statLabel}>Eliminaciones</div>
              </div>
              <div className={styles.statBox}>
                <div className={styles.statValue} style={{ color: '#ff5c7c' }}>
                  {state?.deaths ?? 0}
                </div>
                <div className={styles.statLabel}>Muertes</div>
              </div>
              <div className={styles.statBox}>
                <div className={styles.statValue} style={{ color: '#ffd600' }}>
                  {state?.victories ?? 0}
                </div>
                <div className={styles.statLabel}>Victorias</div>
              </div>
              <div className={styles.statBox}>
                <div className={styles.statValue} style={{ color: '#c084fc' }}>
                  {state?.killStreak ?? 0}
                </div>
                <div className={styles.statLabel}>Racha Kills</div>
              </div>
              <div className={styles.statBox}>
                <div className={styles.statValue} style={{ color: '#22c55e' }}>
                  {state?.maxKillStreak ?? 0}
                </div>
                <div className={styles.statLabel}>Mejor Racha</div>
              </div>
            </div>

            {lastActivation && (
              <div className={styles.lastActivation}>
                <span>💥 Última alerta disparada:</span>
                <strong>{lastActivation}</strong>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnOrange}`}
                onClick={() => sendEvent('kill')}
              >
                🔥 +1 Kill
              </button>
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnRed}`}
                onClick={() => sendEvent('death')}
              >
                💀 +1 Muerte
              </button>
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnYellow}`}
                onClick={() => sendEvent('victory')}
              >
                👑 ¡Victoria Magistral!
              </button>
            </div>
          </div>
        </section>

        {/* Right: Customizable Global Hotkeys + Conflict Detector */}
        <section className={styles.comicPanel}>
          <div className={styles.comicPanelHeader}>
            <div className={styles.panelHeading}>
              <span>⌨️</span>
              <span>Atajos de teclado personalizados</span>
            </div>
            <button
              type="button"
              className={`${styles.comicBtn} ${styles.comicBtnDark} ${styles.comicBtnSm}`}
              onClick={() =>
                mutate((cfg) => ({
                  ...cfg,
                  hotkeys: {
                    kill: HOTKEY_SLOT_LABELS.kill.safeDefault,
                    death: HOTKEY_SLOT_LABELS.death.safeDefault,
                    victory: HOTKEY_SLOT_LABELS.victory.safeDefault,
                  },
                }))
              }
            >
              ↺ Restaurar seguros
            </button>
          </div>

          <div className={styles.comicPanelBody}>
            {totalConflicts > 0 && (
              <div className={styles.conflictBanner}>
                ⚠️ Se han detectado <strong>{totalConflicts} conflicto(s)</strong> de atajos de
                teclado con funciones existentes de StreamDaemon o del sistema. Cambia los atajos
                marcados en rojo antes de guardar.
              </div>
            )}

            <div className={styles.hotkeyList}>
              {(['kill', 'death', 'victory'] as const).map((slot) => {
                const info = HOTKEY_SLOT_LABELS[slot];
                const currentAccel = hotkeys[slot] || '';
                const conflicts = hotkeyConflicts[slot];
                const isRecording = recordingSlot === slot;
                const osState = osHotkeyStatus[slot];

                return (
                  <div
                    key={slot}
                    className={`${styles.hotkeyItem} ${
                      conflicts.length > 0 ? styles.hotkeyItemConflict : ''
                    }`}
                  >
                    <div className={styles.hotkeyMeta}>
                      <span className={styles.hotkeyEventTitle}>
                        {info.icon} {info.title}
                      </span>
                      {conflicts.length > 0 ? (
                        <span className={styles.hotkeyStatusWarn}>⚠️ {conflicts[0]}</span>
                      ) : currentAccel && osState?.ok ? (
                        <span className={styles.hotkeyStatusOk}>✓ Activo globalmente en Windows</span>
                      ) : (
                        <span className={styles.reservedShortcutsNote}>
                          {currentAccel ? 'Guarda para activar el atajo' : 'Desactivado'}
                        </span>
                      )}
                    </div>

                    <div className={styles.hotkeyControls}>
                      <span
                        className={`${styles.hotkeyKeyBadge} ${
                          isRecording ? styles.hotkeyKeyRecording : ''
                        }`}
                      >
                        {isRecording ? 'Pulsa teclas... (ESC cancela)' : formatAccelDisplay(currentAccel)}
                      </span>
                      <button
                        type="button"
                        className={`${styles.comicBtn} ${
                          isRecording ? styles.comicBtnYellow : styles.comicBtnCyan
                        } ${styles.comicBtnSm}`}
                        onClick={() => setRecordingSlot(isRecording ? null : slot)}
                      >
                        {isRecording ? 'Cancelar' : '🎙️ Grabar'}
                      </button>
                      {currentAccel && (
                        <button
                          type="button"
                          className={`${styles.comicBtn} ${styles.comicBtnDark} ${styles.comicBtnSm}`}
                          onClick={() =>
                            mutate((cfg) => ({
                              ...cfg,
                              hotkeys: { ...(cfg.hotkeys ?? {}), [slot]: '' },
                            }))
                          }
                          title="Quitar atajo"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className={styles.reservedShortcutsNote} style={{ margin: 0 }}>
              Atajos reservados por StreamDaemon: <strong>Ctrl+Shift+T</strong> (Overlay click-through),{' '}
              <strong>Ctrl+K</strong> (Paleta de comandos), <strong>Ctrl+1..9</strong> (Pestañas) y{' '}
              <strong>Espacio / R</strong> (Speedrun).
            </p>
          </div>
        </section>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          3. FORTNITE LOW-CPU HUD VISION SCANNER (CV SECTION)
         ═══════════════════════════════════════════════════════════════════ */}
      <VibeCvSection />

      {/* ═══════════════════════════════════════════════════════════════════
          4. CARTOON ALERT RULES (TRIGGERS)
         ═══════════════════════════════════════════════════════════════════ */}
      {config && (
        <section className={styles.comicPanel}>
          <div className={styles.comicPanelHeader}>
            <div className={styles.panelHeading}>
              <span>💥</span>
              <span>Reglas de alertas automáticas ({config.triggers.length})</span>
            </div>
            <span className={`${styles.comicBadge} ${styles.comicBadgeYellow}`}>
              <span>FORTNITE + MULTIJUEGO</span>
            </span>
          </div>

          <div className={styles.comicPanelBody}>
            <div className={styles.triggersGrid}>
              {config.triggers.map((trigger) => (
                <TriggerEditor
                  key={trigger.id}
                  trigger={trigger}
                  onPatch={(patch) => patchTrigger(trigger.id, patch)}
                  onPatchCondition={(patch) => patchCondition(trigger.id, patch)}
                  onPatchAction={(patch) => patchAction(trigger.id, patch)}
                  onDelete={() => deleteTrigger(trigger.id)}
                  onTest={() => testTrigger(trigger)}
                />
              ))}
            </div>

            {/* Add New Alert Rule Bar */}
            <div
              style={{
                paddingTop: '14px',
                borderTop: '2px dashed rgba(255,255,255,0.12)',
              }}
            >
              <div className={styles.panelHeading} style={{ fontSize: '13.5px', marginBottom: '10px' }}>
                <span>➕</span>
                <span>Crear nueva alerta automática</span>
              </div>
              <div className={styles.addForm}>
                <div className={styles.addField}>
                  <label className={styles.fieldLabel}>Juego</label>
                  <select
                    className={styles.fieldInput}
                    value={newGameId}
                    onChange={(e) => setNewGameId(e.target.value)}
                  >
                    <option value="fortnite">🪂 Fortnite</option>
                    <option value="global">🌍 Global (Todos los juegos)</option>
                    <option value="custom">🎮 Otro juego...</option>
                  </select>
                </div>
                {newGameId === 'custom' && (
                  <div className={styles.addField}>
                    <label className={styles.fieldLabel}>ID del juego</label>
                    <input
                      className={styles.fieldInput}
                      value={newGameCustom}
                      placeholder="valorant, warzone..."
                      onChange={(e) => setNewGameCustom(e.target.value)}
                    />
                  </div>
                )}
                <div className={styles.addField}>
                  <label className={styles.fieldLabel}>Nombre de la alerta</label>
                  <input
                    className={styles.fieldInput}
                    value={newName}
                    placeholder="Ej: ¡FRANCOTIRADOR!"
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className={styles.addField}>
                  <label className={styles.fieldLabel}>Evento</label>
                  <select
                    className={styles.fieldInput}
                    value={newEventType}
                    onChange={(e) => setNewEventType(e.target.value as VibeDaemonEventType)}
                  >
                    {EVENT_TYPES.map((et) => (
                      <option key={et} value={et}>
                        {EVENT_META[et].icon} {EVENT_META[et].label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className={`${styles.comicBtn} ${styles.comicBtnYellow}`}
                  onClick={addTrigger}
                >
                  ➕ Añadir alerta
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          5. OBS BROWSER SOURCE URL (CARTOON OVERLAY)
         ═══════════════════════════════════════════════════════════════════ */}
      <section className={styles.comicPanel}>
        <div className={styles.comicPanelHeader}>
          <div className={styles.panelHeading}>
            <span>🔗</span>
            <span>Fuente de Navegador para OBS Studio (1920×1080)</span>
          </div>
        </div>
        <div className={styles.comicPanelBody}>
          <div className={styles.urlBox}>{overlayUrl}</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`${styles.comicBtn} ${styles.comicBtnCyan}`}
              onClick={() => copyUrl('live')}
            >
              {copied === 'live' ? '✓ ¡URL copiada!' : '📋 Copiar URL para OBS'}
            </button>
            <button
              type="button"
              className={`${styles.comicBtn} ${styles.comicBtnPurple}`}
              onClick={() => copyUrl('demo')}
            >
              {copied === 'demo' ? '✓ ¡URL Demo copiada!' : '🎬 Copiar URL en modo Demo'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
