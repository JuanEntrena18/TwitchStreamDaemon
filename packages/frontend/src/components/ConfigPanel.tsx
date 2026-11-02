import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../i18n/context';
import type { LocaleSetting } from '../i18n/types';
import { useSocket } from '../hooks/useSocket';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { apiGet, apiPost } from '../utils/api';
import { ConfirmModal } from './ConfirmModal';
import { Logo } from './Logo';
import { Toggle } from './Toggle';
import { APP_VERSION } from '../version';
import styles from './ConfigPanel.module.css';

interface Props {
  channel: string;
  alwaysOnTop: boolean;
  toggleAlwaysOnTop: () => void;
}

export function ConfigPanel({ channel, alwaysOnTop, toggleAlwaysOnTop }: Props) {
  const { t, localeSetting, setLocale } = useTranslation();
  const { connected } = useSocket();
  const {
    twitchAuthenticated,
    youtubeAuthenticated,
    youtubeAuthMode,
    twitchUser,
    youtubeUser,
    youtubeCredentials,
    loading: authLoading,
    login,
    logout,
    deviceState,
    cancelDeviceLogin,
    saveYouTubeCredentials,
    quickConnectYouTube,
    startYouTubeOAuth,
    logoutYouTube,
    simulateYouTubeEvent,
  } = useAuthStatus();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const [ytTab, setYtTab] = useState<'apikey' | 'oauth'>('apikey');
  const [ytChannelHandle, setYtChannelHandle] = useState('');
  const [ytApiKey, setYtApiKey] = useState('');
  const [ytClientId, setYtClientId] = useState('');
  const [ytClientSecret, setYtClientSecret] = useState('');
  const [ytBusy, setYtBusy] = useState(false);
  const [ytFeedback, setYtFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [uiZoom, setUiZoom] = useState(() => {
    try { return localStorage.getItem('sf-ui-zoom') || 'auto'; } catch { return 'auto'; }
  });

  const [obsHost, setObsHost] = useState('127.0.0.1');
  const [obsPort, setObsPort] = useState('4455');
  const [obsPassword, setObsPassword] = useState('');
  const [obsConnected, setObsConnected] = useState(false);
  const [obsConnecting, setObsConnecting] = useState(false);
  const [obsError, setObsError] = useState('');

  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'uptodate' | 'available' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');

  useEffect(() => {
    apiGet('/obs/status').then(async (r) => {
      if (!r.ok) return;
      const data = await r.json();
      setObsConnected(data.connected);
    }).catch(() => {});
  }, []);

  const connectObs = useCallback(async () => {
    setObsConnecting(true);
    setObsError('');
    try {
      const r = await apiPost('/obs/connect', { host: obsHost, port: parseInt(obsPort, 10), password: obsPassword });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setObsError(data.error || 'Connection failed');
        setObsConnected(false);
      } else {
        setObsConnected(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection error';
      setObsError(message);
      setObsConnected(false);
    } finally {
      setObsConnecting(false);
    }
  }, [obsHost, obsPort, obsPassword]);

  const disconnectObs = useCallback(async () => {
    try {
      await apiPost('/obs/disconnect');
      setObsConnected(false);
    } catch {}
  }, []);

  const handleZoomChange = (val: string) => {
    setUiZoom(val);
    try { localStorage.setItem('sf-ui-zoom', val); } catch {}
    document.documentElement.setAttribute('data-zoom', val);
  };

  const checkUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateVersion('');
    try {
      const r = await fetch('https://api.github.com/repos/JuanEntrena18/StreamForge/releases/latest');
      if (!r.ok) throw new Error('fetch failed');
      const data = await r.json();
      const latest = (data.tag_name || '').replace(/^v/i, '');
      const current = APP_VERSION;
      if (latest && latest !== current) {
        setUpdateVersion(data.tag_name);
        setUpdateStatus('available');
      } else {
        setUpdateStatus('uptodate');
      }
    } catch {
      setUpdateStatus('error');
    }
  }, [t]);

  return (
    <div className={styles.container}>
      <div className="mb-5">
        <h2 className="sf-heading flex-row--gap-sm">
          {t('config.title')}
        </h2>
        <p className="text-sm text-muted">{t('config.subtitle')}</p>
      </div>

      {/* ── Buy Me a Coffee ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('config.apoyoTitle')}</p>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('config.apoyoDesc')}
        </p>

        <div className="flex-row flex-wrap" style={{ gap: '1.25rem' }}>
          <img
            src="/qr-code.png"
            alt="Buy Me a Coffee QR"
            className={styles.qrImg}
          />
          <div style={{ flex: 1, minWidth: 200 }}>
            <a
              href="https://buymeacoffee.com/jentrena"
              target="_blank"
              rel="noreferrer"
              className={styles.bmcBtn}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 4H3c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h8l1 3h-2c-.55 0-1 .45-1 1s.45 1 1 1h6c.55 0 1-.45 1-1s-.45-1-1-1h-2l1-3h8c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1zm-1 10H4V6h16v8z"/>
              </svg>
              {t('config.invitameCafe')}
            </a>
            <div className={styles.bmcLink}>buymeacoffee.com/jentrena</div>
          </div>
        </div>

        <div className="flex-row flex-wrap" style={{ gap: '1.25rem', marginTop: '0.75rem' }}>
          <a
            href="https://paypal.me/jentrena"
            target="_blank"
            rel="noreferrer"
            className={styles.paypalBtn}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106z"/>
            </svg>
            {t('config.donarPaypal')}
          </a>
          <div className={styles.bmcLink}>paypal.me/jentrena</div>
        </div>
      </div>

      {/* ── Twitch Auth ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('config.twitchTitle')}</p>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('config.twitchDesc')}
        </p>

        <div className="flex-row" style={{ gap: '1rem' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12, flexShrink: 0,
            background: twitchAuthenticated ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${twitchAuthenticated ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.25)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem',
          }}>
            {twitchAuthenticated ? '✅' : '🔌'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--sf-text)' }}>
              {twitchAuthenticated && twitchUser ? twitchUser.displayName : t('config.noConectado')}
            </div>
            <div className="text-xs text-dim">
              {twitchAuthenticated
                ? t('config.sesionActiva')
                : t('config.conectaTwitch')}
            </div>
          </div>
          {!authLoading && !twitchAuthenticated && (
            <div className="flex-row--gap-sm" style={{ flexShrink: 0 }}>
              <button
                onClick={login}
                className="sf-btn"
                style={{
                  background: 'linear-gradient(135deg, #9147ff 0%, #6441a5 100%)',
                  color: '#fff', fontSize: '0.8rem', padding: '0.5rem 1rem',
                  gap: '0.4rem', boxShadow: '0 2px 12px rgba(145,71,255,0.35)', whiteSpace: 'nowrap',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
                </svg>
                {t('config.conectar')}
              </button>
            </div>
          )}
          {!authLoading && twitchAuthenticated && (
            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="sf-btn sf-btn-ghost"
              style={{ fontSize: '0.78rem', padding: '0.4rem 0.75rem', color: 'var(--sf-text-3)', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {t('config.desconectar')}
            </button>
          )}
          <ConfirmModal
            open={showLogoutConfirm}
            title={t('config.confirmLogoutTitle')}
            message={t('config.confirmLogoutMsg')}
            confirmLabel={t('config.desconectar')}
            onConfirm={() => { setShowLogoutConfirm(false); logout(); }}
            onCancel={() => setShowLogoutConfirm(false)}
            showDontAskAgain
          />
        </div>

        {/* ── Device Code Dialog ── */}
        {(deviceState.status !== 'idle' || deviceState.error) && (
          <div className={styles.authBox}>
            {deviceState.status === 'loading' && (
              <div className="text-sm text-muted text-center">{t('config.conectando')}</div>
            )}

            {deviceState.status === 'polling' && (
              <>
                <p className="text-sm" style={{ fontWeight: 600, color: 'var(--sf-text)', marginBottom: '0.75rem' }}>
                  {t('config.authTitle')}
                </p>
                <ol style={{ fontSize: '0.82rem', color: 'var(--sf-text-2)', lineHeight: 1.8, paddingLeft: '1.25rem', marginBottom: '1rem' }}>
                  <li>{t('config.authAbre')} <strong style={{ color: 'var(--sf-primary-light)' }}>{deviceState.verificationUri}</strong> {t('config.authEnNavegador')}</li>
                  <li>{t('config.authCodigo')} <strong className={styles.authCode}>{deviceState.userCode}</strong></li>
                  <li>{t('config.authInstrucciones')}</li>
                </ol>
                <div className="flex-row--gap-sm">
                  <a
                    href={deviceState.verificationUri || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="sf-btn"
                    style={{
                      background: 'linear-gradient(135deg, #9147ff 0%, #6441a5 100%)',
                      color: '#fff', fontSize: '0.78rem', padding: '0.4rem 0.875rem',
                      flex: 1, justifyContent: 'center', textDecoration: 'none', display: 'flex', alignItems: 'center'
                    }}
                  >
                    {t('config.abrirTwitchActivate')}
                  </a>
                  <button
                    onClick={cancelDeviceLogin}
                    className="sf-btn"
                    style={{
                      background: 'var(--sf-surface-hover)',
                      color: 'var(--sf-text-2)', fontSize: '0.78rem',
                      padding: '0.4rem 0.875rem',
                    }}
                  >
                    {t('config.cancelar')}
                  </button>
                </div>
              </>
            )}

            {deviceState.error && (
              <p className="sf-error-text">{deviceState.error}</p>
            )}
          </div>
        )}

        {/* Channel connector */}
        <div className={styles.channelSection}>
          <label className="sf-label mb-2" style={{ fontWeight: 500 }}>
            {t('config.canalActivo')}
          </label>
          <div className="flex-row--gap-sm">
            <span style={{ fontSize: '1rem', color: 'var(--sf-text-3)' }}>#</span>
            <input
              type="text"
              value={channel}
              placeholder={t('config.canalPlaceholder')}
              className="sf-input"
              style={{ flex: 1 }}
              readOnly
            />
            <div
              className={`sf-badge ${connected ? 'sf-badge-success' : 'sf-badge-danger'}`}
              style={{ flexShrink: 0 }}
            >
              <span className={styles.statusDot} style={{ background: connected ? 'var(--sf-success)' : 'var(--sf-danger)' }} />
              {connected ? t('config.conectadoBadge') : t('config.desconectadoBadge')}
            </div>
          </div>
        </div>
      </div>

      {/* ── Re-auth note ── */}
      {twitchAuthenticated && (
        <div className={styles.reauthNote}>
          {t('config.infoEventsub')}
        </div>
      )}

      {/* ── YouTube Live Integration ── */}
      <div className="glass-card sf-card">
        <div className="flex-between" style={{ marginBottom: '0.35rem' }}>
          <p className="sf-section-title" style={{ margin: 0 }}>YouTube Live · Emisiones en Directo & Multistream</p>
          <span
            className="sf-badge"
            style={{
              background: youtubeAuthenticated ? 'rgba(16,185,129,0.15)' : 'rgba(255,0,51,0.12)',
              color: youtubeAuthenticated ? 'var(--sf-success)' : '#ff4d6d',
              border: `1px solid ${youtubeAuthenticated ? 'rgba(16,185,129,0.3)' : 'rgba(255,0,51,0.3)'}`,
              fontSize: '0.7rem',
            }}
          >
            {youtubeAuthenticated
              ? `CONECTADO (${youtubeAuthMode === 'oauth' ? 'OAuth 2.0' : 'API Key'})`
              : 'LISTO PARA CONECTAR'}
          </span>
        </div>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          Conecta tu canal de YouTube para recibir chat en vivo, Super Chats, miembros del canal, suscriptores y espectadores combinados en todos los +57 overlays, alertas, sorteos y avatares.
        </p>

        {/* Active YouTube connection status */}
        <div className="flex-row" style={{ gap: '1rem', marginBottom: '1rem' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12, flexShrink: 0,
            background: youtubeAuthenticated ? 'rgba(16,185,129,0.15)' : 'rgba(255,0,51,0.12)',
            border: `1px solid ${youtubeAuthenticated ? 'rgba(16,185,129,0.3)' : 'rgba(255,0,51,0.28)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem',
          }}>
            {youtubeAuthenticated ? '▶️' : '📺'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--sf-text)' }}>
              {youtubeAuthenticated && youtubeUser ? youtubeUser.displayName : 'Canal de YouTube no conectado'}
            </div>
            <div className="text-xs text-dim">
              {youtubeAuthenticated && youtubeUser
                ? `ID/Handle: ${youtubeUser.login} · Modo ${youtubeAuthMode === 'oauth' ? 'OAuth 2.0 Completo' : 'Lectura en vivo con API Key'}`
                : 'Configura tu API Key de YouTube Data v3 o credenciales OAuth 2.0 abajo'}
            </div>
          </div>
          {youtubeAuthenticated && (
            <button
              type="button"
              onClick={() => logoutYouTube()}
              className="sf-btn sf-btn-ghost"
              style={{ fontSize: '0.78rem', padding: '0.4rem 0.75rem', color: 'var(--sf-text-3)', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {t('config.desconectar')}
            </button>
          )}
        </div>

        {/* Mode Tabs */}
        <div className="flex-row--gap-sm" style={{ marginBottom: '0.85rem' }}>
          <button
            type="button"
            onClick={() => { setYtTab('apikey'); setYtFeedback(null); }}
            className={`sf-btn ${ytTab === 'apikey' ? 'sf-btn-primary' : 'sf-btn-ghost'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: '0.78rem', padding: '0.45rem 0.75rem' }}
          >
            ⚡ Conexión Rápida (API Key + @Canal)
          </button>
          <button
            type="button"
            onClick={() => { setYtTab('oauth'); setYtFeedback(null); }}
            className={`sf-btn ${ytTab === 'oauth' ? 'sf-btn-primary' : 'sf-btn-ghost'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: '0.78rem', padding: '0.45rem 0.75rem' }}
          >
            🔐 OAuth 2.0 Completo (Google Cloud)
          </button>
        </div>

        {ytTab === 'apikey' ? (
          <div className="flex-col flex-col--gap-sm">
            <div>
              <label className="sf-label text-xs" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                <span>YouTube Data API v3 Key</span>
                {youtubeCredentials?.hasApiKey && (
                  <span style={{ color: 'var(--sf-success)' }}>✓ Guardada ({youtubeCredentials.apiKeyPreview})</span>
                )}
              </label>
              <input
                type="password"
                value={ytApiKey}
                onChange={(e) => setYtApiKey(e.target.value)}
                placeholder={youtubeCredentials?.hasApiKey ? 'Dejar vacío para usar la API Key guardada o introduce una nueva...' : 'AIzaSy...'}
                className="sf-input text-xs"
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <label className="sf-label text-xs" style={{ display: 'block', marginBottom: '0.25rem' }}>
                Canal de YouTube (@handle o ID UC...)
              </label>
              <div className="flex-row--gap-sm">
                <input
                  type="text"
                  value={ytChannelHandle}
                  onChange={(e) => setYtChannelHandle(e.target.value)}
                  placeholder="@TuCanal o UCxxxxxxxxxxxx"
                  className="sf-input text-xs"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  disabled={ytBusy}
                  onClick={async () => {
                    if (!ytChannelHandle.trim()) {
                      setYtFeedback({ type: 'err', text: 'Introduce el @handle o ID de tu canal de YouTube.' });
                      return;
                    }
                    setYtBusy(true);
                    setYtFeedback(null);
                    try {
                      await quickConnectYouTube(ytChannelHandle.trim(), ytApiKey.trim() || undefined);
                      setYtChannelHandle('');
                      setYtApiKey('');
                      setYtFeedback({ type: 'ok', text: '¡Canal de YouTube conectado correctamente!' });
                    } catch (err) {
                      setYtFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Error al conectar YouTube' });
                    } finally {
                      setYtBusy(false);
                    }
                  }}
                  className="sf-btn"
                  style={{
                    background: 'linear-gradient(135deg, #ff0033 0%, #c9002b 100%)',
                    color: '#fff',
                    fontSize: '0.78rem',
                    padding: '0.45rem 1rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ytBusy ? 'Conectando...' : 'Conectar YouTube'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-col flex-col--gap-sm">
            <div>
              <label className="sf-label text-xs" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                <span>Google OAuth Client ID</span>
                {youtubeCredentials?.hasClientId && (
                  <span style={{ color: 'var(--sf-success)' }}>✓ Guardado ({youtubeCredentials.clientIdPreview})</span>
                )}
              </label>
              <input
                type="text"
                value={ytClientId}
                onChange={(e) => setYtClientId(e.target.value)}
                placeholder={youtubeCredentials?.hasClientId ? 'Dejar vacío para usar el Client ID guardado...' : '123456789-xxx.apps.googleusercontent.com'}
                className="sf-input text-xs"
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <label className="sf-label text-xs" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                <span>Google OAuth Client Secret</span>
                {youtubeCredentials?.hasClientSecret && (
                  <span style={{ color: 'var(--sf-success)' }}>✓ Guardado</span>
                )}
              </label>
              <input
                type="password"
                value={ytClientSecret}
                onChange={(e) => setYtClientSecret(e.target.value)}
                placeholder={youtubeCredentials?.hasClientSecret ? 'Dejar vacío para usar el Secret guardado...' : 'GOCSPX-...'}
                className="sf-input text-xs"
                style={{ width: '100%' }}
              />
            </div>

            <div className="text-xs text-dim" style={{ padding: '0.45rem 0.65rem', background: 'rgba(0,0,0,0.22)', borderRadius: 6, border: '1px solid var(--sf-border)' }}>
              Redirect URI en Google Cloud Console:{' '}
              <code style={{ color: 'var(--sf-primary-light)' }}>
                {youtubeCredentials?.redirectUri || 'http://localhost:3000/auth/youtube/callback'}
              </code>
            </div>

            <div className="flex-row--gap-sm">
              <button
                type="button"
                disabled={ytBusy}
                onClick={async () => {
                  setYtBusy(true);
                  setYtFeedback(null);
                  try {
                    await saveYouTubeCredentials({
                      clientId: ytClientId.trim() || undefined,
                      clientSecret: ytClientSecret.trim() || undefined,
                      apiKey: ytApiKey.trim() || undefined,
                    });
                    setYtClientId('');
                    setYtClientSecret('');
                    setYtFeedback({ type: 'ok', text: 'Credenciales de YouTube guardadas y cifradas.' });
                  } catch (err) {
                    setYtFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Error al guardar credenciales' });
                  } finally {
                    setYtBusy(false);
                  }
                }}
                className="sf-btn sf-btn-ghost"
                style={{ fontSize: '0.78rem', padding: '0.45rem 0.85rem' }}
              >
                Guardar Credenciales
              </button>
              <button
                type="button"
                disabled={ytBusy}
                onClick={async () => {
                  setYtBusy(true);
                  setYtFeedback(null);
                  try {
                    await startYouTubeOAuth({
                      clientId: ytClientId.trim() || undefined,
                      clientSecret: ytClientSecret.trim() || undefined,
                    });
                    setYtFeedback({ type: 'ok', text: 'Se abrió la ventana de autorización de Google en tu navegador.' });
                  } catch (err) {
                    setYtFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Error al iniciar OAuth' });
                  } finally {
                    setYtBusy(false);
                  }
                }}
                className="sf-btn"
                style={{
                  background: 'linear-gradient(135deg, #ff0033 0%, #c9002b 100%)',
                  color: '#fff',
                  fontSize: '0.78rem',
                  padding: '0.45rem 1rem',
                  flex: 1,
                  justifyContent: 'center',
                }}
              >
                Autorizar con Google / YouTube
              </button>
            </div>
          </div>
        )}

        {ytFeedback && (
          <p
            className="text-xs"
            style={{
              marginTop: '0.6rem',
              color: ytFeedback.type === 'ok' ? 'var(--sf-success)' : 'var(--sf-danger)',
            }}
          >
            {ytFeedback.text}
          </p>
        )}

        {/* YouTube Live Alert & Chat Simulator */}
        <div style={{ marginTop: '1.1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--sf-border)' }}>
          <div className="text-xs" style={{ fontWeight: 600, color: 'var(--sf-text-2)', marginBottom: '0.5rem' }}>
            🧪 Probar Eventos de YouTube en Overlays y Chat (OBS / Dashboard)
          </div>
          <div className="flex-row flex-wrap" style={{ gap: '0.45rem' }}>
            {[
              { type: 'chat' as const, label: '💬 Mensaje YT' },
              { type: 'subscriber' as const, label: '🔔 Nuevo Suscriptor YT' },
              { type: 'member' as const, label: '⭐ Nuevo Miembro YT' },
              { type: 'milestone' as const, label: '🏅 Miembro 6 Meses' },
              { type: 'gift' as const, label: '🎁 5 Membresías Regalo' },
              { type: 'superchat' as const, label: '💸 Super Chat 20€' },
            ].map((sim) => (
              <button
                key={sim.type}
                type="button"
                onClick={async () => {
                  try {
                    await simulateYouTubeEvent({ type: sim.type, amount: 20, currency: 'EUR', months: 6, count: 5 });
                    setYtFeedback({ type: 'ok', text: `Evento simulado enviado a los overlays: ${sim.label}` });
                  } catch (err) {
                    setYtFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Error al simular evento' });
                  }
                }}
                className="sf-btn sf-btn-ghost"
                style={{ fontSize: '0.72rem', padding: '0.35rem 0.65rem' }}
              >
                {sim.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Always on top ── */}
      {window.streamforger && (
        <div className="glass-card sf-card">
          <p className="sf-section-title">{t('config.ventanaTitle')}</p>

          <div className="flex-between">
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--sf-text)', marginBottom: '0.1rem' }}>
                {t('config.siempreEncima')}
              </div>
              <div className="text-xs text-dim">{t('config.siempreEncimaDesc')}</div>
            </div>
            <Toggle
              checked={alwaysOnTop}
              onChange={toggleAlwaysOnTop}
            />
          </div>
        </div>
      )}

      {/* ── Language ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('config.languageTitle') || 'Idioma / Language'}</p>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('config.languageDesc') || 'Selecciona el idioma de la interfaz.'}
        </p>

        <div className="flex-row flex-wrap" style={{ gap: '0.75rem' }}>
          {([
            { id: 'auto', label: 'Auto', icon: '🌐' },
            { id: 'es', label: 'Español', icon: '🇪🇸' },
            { id: 'en', label: 'English', icon: '🇬🇧' },
            { id: 'fr', label: 'Français', icon: '🇫🇷' },
            { id: 'de', label: 'Deutsch', icon: '🇩🇪' },
            { id: 'it', label: 'Italiano', icon: '🇮🇹' },
          ] as { id: LocaleSetting; label: string; icon: string }[]).map(lang => (
            <button
              key={lang.id}
              onClick={() => setLocale(lang.id)}
              className={`sf-btn ${localeSetting === lang.id ? 'sf-btn-primary' : 'sf-btn-ghost'}`}
              style={{ flex: 1, minWidth: '100px', padding: '0.6rem', justifyContent: 'center' }}
            >
              <span style={{ fontSize: '1.2rem', marginRight: '0.5rem' }}>{lang.icon}</span>
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── OBS WebSocket ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('obs.obsWsTitle')}</p>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('obs.obsWsHelp')}
        </p>

        <div className="flex-col flex-col--gap-sm">
          {!obsConnected ? (
            <>
              <div className="flex-row flex-row--gap-sm" style={{ alignItems: 'center' }}>
                <input type="text" value={obsHost} onChange={(e) => setObsHost(e.target.value)} placeholder={t('obs.obsWsHost')} className="sf-input text-xs" style={{ width: 140 }} />
                <span style={{ color: 'var(--sf-text-3)' }}>:</span>
                <input type="text" value={obsPort} onChange={(e) => setObsPort(e.target.value)} placeholder="4455" className="sf-input text-xs" style={{ width: 70 }} />
                <input type="password" value={obsPassword} onChange={(e) => setObsPassword(e.target.value)} placeholder={t('obs.obsWsPassword')} className="sf-input text-xs" style={{ width: 140 }} />
                <button onClick={connectObs} disabled={obsConnecting} className="sf-btn sf-btn-primary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.75rem' }}>
                  {obsConnecting ? '...' : t('obs.obsWsConnect')}
                </button>
              </div>
              {obsError && <p className="text-xs" style={{ color: 'var(--sf-danger)' }}>{obsError}</p>}
            </>
          ) : (
            <div className="flex-row flex-row--gap-sm" style={{ alignItems: 'center' }}>
              <span className="sf-badge sf-badge-success text-xs">{t('obs.obsWsConnected')}</span>
              <span className="text-xs" style={{ color: 'var(--sf-text-3)' }}>{t('obs.obsWsConnectedTo')} {obsHost}:{obsPort}</span>
              <button onClick={disconnectObs} className="sf-btn" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}>
                {t('obs.obsWsDisconnect')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── UI Zoom ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('config.uiZoomTitle') || 'Tamaño de la interfaz'}</p>
        <p className="text-sm text-muted" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('config.uiZoomDesc') || 'Ajusta el zoom para monitores 2K/4K o según tu preferencia visual.'}
        </p>

        <div className="flex-row flex-wrap" style={{ gap: '0.75rem' }}>
          {[
            { id: 'auto', label: t('config.zoomAuto') || 'Auto' },
            { id: '100', label: t('config.zoomNormal') || '100%' },
            { id: '125', label: t('config.zoomLarge') || '125%' },
            { id: '150', label: t('config.zoomXLarge') || '150%' },
            { id: '200', label: t('config.zoomHuge') || '200%' },
          ].map(opt => (
            <button
              key={opt.id}
              onClick={() => handleZoomChange(opt.id)}
              className={`sf-btn ${uiZoom === opt.id ? 'sf-btn-primary' : 'sf-btn-ghost'}`}
              style={{ flex: 1, minWidth: '80px', padding: '0.6rem', justifyContent: 'center' }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── About ── */}
      <div className="glass-card sf-card">
        <p className="sf-section-title">{t('config.acercaDe')}</p>

        <div className="flex-row" style={{ gap: '1rem', marginBottom: '1.25rem' }}>
          <div className="animate-float"><Logo size={48} /></div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--sf-text)' }}>
              {t('config.appName')}
            </div>
            <div className="text-xs text-dim" style={{ marginTop: '2px' }}>
              {`v${APP_VERSION} · by Cyber Haute Couture`}
            </div>
          </div>
        </div>

        <p className="text-sm text-muted" style={{ lineHeight: 1.7, marginBottom: '1.25rem' }}>
          {t('config.appDesc')}
        </p>

        <div className="flex-row flex-wrap" style={{ gap: '0.75rem', marginBottom: '1rem', alignItems: 'center' }}>
          <button className={styles.updateBtn} onClick={checkUpdate} disabled={updateStatus === 'checking'}>
            {updateStatus === 'checking' ? t('config.updateChecking') : t('config.checkUpdate')}
          </button>
          {updateStatus === 'uptodate' && (
            <span className="text-xs" style={{ color: 'var(--sf-success)' }}>{t('config.updateUpToDate')}</span>
          )}
          {updateStatus === 'available' && (
            <span className="text-xs" style={{ color: 'var(--sf-warning)' }}>
              {t('config.updateAvailable', { version: updateVersion })}
            </span>
          )}
          {updateStatus === 'error' && (
            <span className="text-xs" style={{ color: 'var(--sf-danger)' }}>{t('config.updateError')}</span>
          )}
        </div>

        <div className={styles.githubBox}>
          <span style={{ fontSize: '1.25rem' }}>🐙</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--sf-text)' }}>
              {t('config.githubTitle')}
            </div>
            <div className="text-xs text-dim">{t('config.githubDesc')}</div>
          </div>
          <a
            href="https://github.com/JuanEntrena18/StreamForge"
            target="_blank"
            rel="noreferrer"
            className={styles.githubBtn}
          >
            {t('config.irRepo')}
          </a>
        </div>

        <div className={styles.licenseLine}>{t('config.licencia')}</div>
      </div>
    </div>
  );
}
