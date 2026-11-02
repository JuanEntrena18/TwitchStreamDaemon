import { useEffect, useState, useRef } from 'react';
import { useTranslation } from '../i18n/context';
import { Logo } from './Logo';
import { APP_VERSION_LABEL } from '../version';
import { BACKEND_URL } from '../utils/api';
import styles from './SplashScreen.module.css';
const POLL_INTERVAL = 450;
const MAX_WAIT = 5000;
const isDesktop = typeof window !== 'undefined' && typeof window.streamforger !== 'undefined';

interface Props {
  onReady: () => void;
}

interface BootModule {
  id: string;
  code: string;
  label: string;
  detail: string;
  threshold: number;
}

const BOOT_MODULES: BootModule[] = [
  {
    id: 'core',
    code: 'SYS-01',
    label: 'Core & SQLite WAL',
    detail: 'Cifrado local AES-256-GCM y persistencia',
    threshold: 15,
  },
  {
    id: 'socket',
    code: 'BUS-02',
    label: 'Socket.IO Realtime Hub',
    detail: ' Telemetría y sincronización a 60 FPS',
    threshold: 42,
  },
  {
    id: 'multistream',
    code: 'NET-03',
    label: 'Multistream Twitch + YouTube',
    detail: 'EventSub WS, IRC & YouTube Live API v3',
    threshold: 68,
  },
  {
    id: 'overlays',
    code: 'HUD-04',
    label: 'Broadcast & Overlays Engine',
    detail: '59+ Escenas modulares, OBS WS & Raider.IO',
    threshold: 90,
  },
];

export function SplashScreen({ onReady }: Props) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState(8);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'timeout'>('connecting');
  const [exiting, setExiting] = useState(false);
  const calledRef = useRef(false);

  useEffect(() => {
    const startTime = Date.now();

    const finishBoot = (finalStatus: 'connected' | 'timeout') => {
      if (calledRef.current) return;
      calledRef.current = true;
      setProgress(100);
      setStatus(finalStatus);
      setTimeout(() => {
        setExiting(true);
      }, 420);
      setTimeout(() => {
        onReady();
      }, 720);
    };

    const poll = async () => {
      if (calledRef.current) return;
      try {
        const r = await fetch(`${BACKEND_URL}/auth/status`, {
          signal: AbortSignal.timeout(2500),
        });
        if (r.ok && !calledRef.current) {
          finishBoot('connected');
        }
      } catch {
        // Keep polling until backend is ready or MAX_WAIT expires
      }
    };

    // Progreso fluido mientras inicializan los subsistemas
    const progressInterval = setInterval(() => {
      if (calledRef.current) return;
      const elapsed = Date.now() - startTime;
      const ratio = Math.min(elapsed / MAX_WAIT, 1);
      // Curva ease-out suave hasta el 94%
      const eased = 1 - Math.pow(1 - ratio, 2.2);
      const pct = Math.min(Math.max(8, Math.round(eased * 94)), 94);
      setProgress(pct);
    }, 60);

    const pollInterval = setInterval(poll, POLL_INTERVAL);
    // Pequeño margen inicial para mostrar la secuencia de arranque limpia
    const initialPoll = setTimeout(poll, 260);

    const fallback = setTimeout(() => {
      finishBoot('timeout');
    }, MAX_WAIT);

    return () => {
      clearInterval(progressInterval);
      clearInterval(pollInterval);
      clearTimeout(initialPoll);
      clearTimeout(fallback);
    };
  }, [onReady]);

  const roundedProgress = Math.min(100, Math.max(0, Math.round(progress)));

  const getStatusMessage = () => {
    if (status === 'connected') {
      return t('splash.conectado') || 'Motor StreamDaemon en línea · Abriendo estudio';
    }
    if (status === 'timeout') {
      return t('splash.timeout') || 'Iniciando interfaz de control local…';
    }
    if (roundedProgress < 35) {
      return 'Inicializando motor local y bóveda AES-256-GCM…';
    }
    if (roundedProgress < 70) {
      return 'Sincronizando bus Socket.IO y conectores Multistream…';
    }
    return t('splash.cargando') || 'Conectando con el servidor local StreamDaemon…';
  };

  return (
    <div className={`${styles.wrapper} ${exiting ? styles.wrapperExit : ''}`}>
      {/* Barra de ventana arrastrable en Desktop (Electron) */}
      {isDesktop && (
        <div
          className={styles.titlebar}
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className={styles.titlebarBrand}>
            <span className={styles.titlebarDot} />
            <span>STREAMDAEMON STUDIO</span>
          </div>
          <div
            className={styles.titlebarActions}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              onClick={() => window.streamforger?.window.minimize()}
              title={t('app.minimizar') || 'Minimizar'}
              aria-label={t('app.minimizar') || 'Minimizar'}
              className={styles.winBtn}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <line x1="2" y1="5" x2="8" y2="5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
            <button
              onClick={() => window.streamforger?.window.close()}
              title={t('app.cerrar') || 'Cerrar'}
              aria-label={t('app.cerrar') || 'Cerrar'}
              className={`${styles.winBtn} ${styles.winBtnClose}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.4" />
                <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Capas atmosféricas de fondo */}
      <div className={styles.bgGrid} aria-hidden="true" />
      <div className={styles.bgGlowPrimary} aria-hidden="true" />
      <div className={styles.bgGlowSecondary} aria-hidden="true" />

      {/* Esquinas de telemetría */}
      <div className={`${styles.cornerHud} ${styles.cornerTL}`} aria-hidden="true">
        <span>SYS // LOCAL-FIRST ENGINE</span>
      </div>
      <div className={`${styles.cornerHud} ${styles.cornerTR}`} aria-hidden="true">
        <span>PORT // 3000 · WAL ACTIVE</span>
      </div>

      {/* Consola central de arranque */}
      <main className={styles.consoleCard} aria-live="polite">
        <div className={styles.topAccentBar} />

        {/* Cabecera superior de la tarjeta */}
        <div className={styles.cardHeaderRow}>
          <span className={styles.studioEyebrow}>CYBER HAUTE COUTURE · BROADCAST SUITE</span>
          <span className={styles.versionBadge}>{APP_VERSION_LABEL}</span>
        </div>

        {/* Emblema Hero con anillo orbital */}
        <div className={styles.emblemStage}>
          <div className={styles.orbitalGlow} />
          <div className={styles.orbitalRingOuter} />
          <div className={styles.orbitalRingInner} />
          <div className={styles.logoContainer}>
            <Logo size={92} className={styles.heroLogo} />
          </div>
          <span
            className={`${styles.emblemStatePill} ${
              status === 'connected' ? styles.emblemStatePillReady : ''
            }`}
          >
            <span className={styles.emblemStateDot} />
            {status === 'connected' ? 'ENGINE ONLINE' : 'INITIALIZING'}
          </span>
        </div>

        {/* Identidad tipográfica */}
        <div className={styles.brandBlock}>
          <h1 className={styles.wordmark}>
            Stream<span className={styles.wordmarkAccent}>Daemon</span>
          </h1>
          <p className={styles.tagline}>
            {t('splash.tagline') ||
              'Plataforma local-first de producción en directo, chat multistream y overlays modulares.'}
          </p>
        </div>

        {/* Matriz de subsistemas en tiempo real */}
        <div className={styles.modulesGrid}>
          {BOOT_MODULES.map((mod) => {
            const isDone = status === 'connected' || roundedProgress >= mod.threshold;
            const isCurrent =
              !isDone && roundedProgress >= Math.max(0, mod.threshold - 28);

            return (
              <div
                key={mod.id}
                className={`${styles.moduleItem} ${
                  isDone
                    ? styles.moduleItemDone
                    : isCurrent
                      ? styles.moduleItemActive
                      : ''
                }`}
              >
                <div className={styles.moduleTop}>
                  <span className={styles.moduleCode}>{mod.code}</span>
                  <span className={styles.moduleStatusIcon}>
                    {isDone ? '✓ READY' : isCurrent ? 'SYNC…' : 'WAIT'}
                  </span>
                </div>
                <div className={styles.moduleLabel}>{mod.label}</div>
                <div className={styles.moduleDetail}>{mod.detail}</div>
              </div>
            );
          })}
        </div>

        {/* Barra de progreso de alta precisión */}
        <div className={styles.telemetryProgressSection}>
          <div className={styles.statusHeader}>
            <div className={styles.statusLeft}>
              <span
                className={`${styles.statusDot} ${
                  status === 'connected' ? styles.statusDotOk : ''
                }`}
              />
              <span className={styles.statusLabel}>{getStatusMessage()}</span>
            </div>
            <span className={styles.progressNumber}>
              {String(roundedProgress).padStart(2, '0')}%
            </span>
          </div>

          <div className={styles.progressTrack}>
            <div
              className={`${styles.progressFill} ${
                status === 'connected' ? styles.progressFillComplete : ''
              }`}
              style={{ width: `${roundedProgress}%` }}
            />
          </div>
        </div>

        {/* Insignias de ecosistema */}
        <div className={styles.platformRow}>
          <span className={styles.platformChip}>
            <span className={styles.dotTwitch} /> TWITCH EVENTSUB
          </span>
          <span className={styles.platformChip}>
            <span className={styles.dotYoutube} /> YOUTUBE LIVE
          </span>
          <span className={styles.platformChip}>
            <span className={styles.dotObs} /> OBS WEBSOCKET v5
          </span>
          <span className={styles.platformChip}>
            <span className={styles.dotRaider} /> RAIDER.IO & TRACKER
          </span>
        </div>
      </main>

      {/* Pie de estudio */}
      <footer className={styles.footer}>
        <span className={styles.footerCopy}>StreamDaemon by Cyber Haute Couture</span>
        <span className={styles.footerSep}>·</span>
        <a
          href="https://github.com/JuanEntrena18/StreamForge"
          target="_blank"
          rel="noreferrer"
          className={styles.footerLink}
        >
          GitHub
        </a>
        <span className={styles.footerSep}>·</span>
        <a
          href="https://buymeacoffee.com/jentrena"
          target="_blank"
          rel="noreferrer"
          className={styles.footerLink}
        >
          {t('splash.apoya') || 'Apoya el proyecto'}
        </a>
        <span className={styles.footerSep}>·</span>
        <span className={styles.footerVersion}>{APP_VERSION_LABEL}</span>
      </footer>
    </div>
  );
}
