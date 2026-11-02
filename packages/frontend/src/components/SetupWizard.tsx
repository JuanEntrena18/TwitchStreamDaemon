import { useState } from 'react';
import { useTranslation } from '../i18n/context';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { Logo } from './Logo';
import styles from './SetupWizard.module.css';

interface Props {
  onComplete: () => void;
}

const LS_KEY = 'streamforger-setup-complete';

export function isSetupComplete(): boolean {
  try { return localStorage.getItem(LS_KEY) === 'true'; } catch { return false; }
}

export function markSetupComplete() {
  try { localStorage.setItem(LS_KEY, 'true'); } catch {}
}

export function SetupWizard({ onComplete }: Props) {
  const { t } = useTranslation();
  const {
    authenticated,
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
    quickConnectYouTube,
    startYouTubeOAuth,
    logoutYouTube,
  } = useAuthStatus();

  const [ytMode, setYtMode] = useState<'apikey' | 'oauth'>('apikey');
  const [ytChannelInput, setYtChannelInput] = useState('');
  const [ytApiKey, setYtApiKey] = useState('');
  const [ytClientId, setYtClientId] = useState('');
  const [ytClientSecret, setYtClientSecret] = useState('');
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState('');
  const [showYtHelp, setShowYtHelp] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);

  const handleFinish = () => {
    markSetupComplete();
    onComplete();
  };

  const handleQuickConnectYt = async () => {
    if (!ytChannelInput.trim()) {
      setYtError('Introduce el @handle o ID de tu canal de YouTube (ej. @Rubius o UC...)');
      return;
    }
    setYtBusy(true);
    setYtError('');
    try {
      await quickConnectYouTube(ytChannelInput.trim(), ytApiKey.trim() || undefined);
      setYtChannelInput('');
      setYtApiKey('');
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Error al conectar YouTube');
    } finally {
      setYtBusy(false);
    }
  };

  const handleOAuthConnectYt = async () => {
    setYtBusy(true);
    setYtError('');
    try {
      await startYouTubeOAuth({
        clientId: ytClientId.trim() || undefined,
        clientSecret: ytClientSecret.trim() || undefined,
      });
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Error al iniciar OAuth de YouTube');
    } finally {
      setYtBusy(false);
    }
  };

  const redirectUri = youtubeCredentials?.redirectUri || 'http://localhost:3000/auth/youtube/callback';

  const copyRedirectUri = () => {
    navigator.clipboard.writeText(redirectUri).catch(() => {});
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 2000);
  };

  const steps = [
    { key: 'twitch', label: t('setup.twitch'), done: twitchAuthenticated, comingSoon: false },
    { key: 'youtube', label: t('setup.youtube'), done: youtubeAuthenticated, comingSoon: false },
    { key: 'tiktok', label: t('setup.tiktok'), done: false, comingSoon: true },
  ];

  return (
    <div className={styles.wrapper}>
      <div className={styles.bgGlow} style={{
        background: `
          radial-gradient(ellipse 60% 50% at 50% 30%, rgba(124,58,237,0.15) 0%, transparent 70%),
          radial-gradient(ellipse 40% 30% at 50% 80%, rgba(255,0,51,0.08) 0%, transparent 70%)
        `,
      }} />

      <div className={styles.content}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.logoWrap}>
            <Logo size={56} />
          </div>
          <h1 className={styles.welcome}>
            {t('setup.welcome')}
          </h1>
          <p className={styles.description}>
            {t('setup.description')}
          </p>
        </div>

        {/* Steps */}
        <div className={styles.steps}>
          {steps.map((step, i) => {
            let cardClass = styles.stepCard + ' sf-card';
            if (step.done) cardClass += ` ${styles['stepCard--done']}`;
            else if (step.comingSoon) cardClass += ` ${styles['stepCard--comingSoon']}`;
            else cardClass += ` ${styles['stepCard--pending']}`;

            let numClass = styles.stepNumber;
            if (step.done) numClass += ` ${styles['stepNumber--done']}`;
            else if (step.comingSoon) numClass += ` ${styles['stepNumber--comingSoon']}`;
            else numClass += ` ${styles['stepNumber--active']}`;

            return (
              <div key={step.key} className={cardClass}>
                <div className={styles.stepRow}>
                  <div className={numClass}>
                    {step.done ? '✓' : step.comingSoon ? '⏳' : i + 1}
                  </div>

                  <div className={styles.stepContent}>
                    <div className={styles.stepLabel}>
                      {step.label}
                      {step.key === 'youtube' && (
                        <span className={styles.ytNewBadge}>NUEVO · MULTISTREAM</span>
                      )}
                      {step.comingSoon && (
                        <span className={styles.comingSoonBadge}>
                          {t('setup.comingSoon')}
                        </span>
                      )}
                    </div>

                    {/* ── TWITCH STEP ── */}
                    {step.key === 'twitch' && (
                      <div>
                        {!authLoading && twitchAuthenticated && twitchUser ? (
                          <div className={styles.connectedRow}>
                            <div className={styles.authBadge}>
                              <div className={styles.authAvatar}>
                                {twitchUser.displayName.charAt(0).toUpperCase()}
                              </div>
                              <span className={styles.authName}>
                                {twitchUser.displayName}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={logout}
                              className={styles.disconnectMiniBtn}
                            >
                              {t('config.desconectar')}
                            </button>
                          </div>
                        ) : (
                          <div className={styles.connectDesc}>
                            <p className="mb-2">{t('setup.connectTwitchDesc')}</p>
                            <div className={styles.connectBtnWrap}>
                              <button
                                onClick={login}
                                className={`sf-btn ${styles.twitchBtn}`}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
                                </svg>
                                {t('setup.connectDeviceCode')}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Device Code Dialog */}
                        {deviceState.status === 'polling' && (
                          <div className={styles.deviceCodeBox}>
                            <p className={styles.deviceCodeTitle}>
                              {t('config.authTitle')}
                            </p>
                            <ol className={styles.deviceCodeSteps}>
                              <li>
                                {t('config.authAbre')}{' '}
                                <strong className={styles.codeHighlight}>{deviceState.verificationUri}</strong>{' '}
                                {t('config.authEnNavegador')}
                              </li>
                              <li>
                                {t('config.authCodigo')}{' '}
                                <strong className={styles.codeValue}>
                                  {deviceState.userCode}
                                </strong>
                              </li>
                              <li>{t('config.authInstrucciones')}</li>
                            </ol>
                            <div className={styles.deviceActions}>
                              <a
                                href={deviceState.verificationUri || '#'}
                                target="_blank"
                                rel="noreferrer"
                                className={`sf-btn ${styles.openTwitchBtn}`}
                                style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                              >
                                {t('config.abrirTwitchActivate')}
                              </a>
                              <button
                                onClick={cancelDeviceLogin}
                                className={`sf-btn ${styles.cancelBtn}`}
                              >
                                {t('config.cancelar')}
                              </button>
                            </div>
                            {deviceState.error && (
                              <p className={styles.errorText}>
                                {deviceState.error}
                              </p>
                            )}
                          </div>
                        )}

                        {deviceState.status === 'idle' && deviceState.error && (
                          <p className={styles.errorText} style={{ marginTop: '0.75rem', color: 'var(--sf-danger)', fontSize: '0.85rem' }}>
                            {deviceState.error}
                          </p>
                        )}
                      </div>
                    )}

                    {/* ── YOUTUBE LIVE STEP ── */}
                    {step.key === 'youtube' && (
                      <div>
                        {!authLoading && youtubeAuthenticated && youtubeUser ? (
                          <div className={styles.connectedRow}>
                            <div className={styles.authBadge}>
                              <div className={styles.ytAvatar}>
                                ▶
                              </div>
                              <span className={styles.authName}>
                                {youtubeUser.displayName}
                              </span>
                              <span className={styles.ytModePill}>
                                {youtubeAuthMode === 'oauth' ? 'OAuth 2.0' : 'API Key'}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={logoutYouTube}
                              className={styles.disconnectMiniBtn}
                            >
                              {t('config.desconectar')}
                            </button>
                          </div>
                        ) : (
                          <div className={styles.connectDesc}>
                            <p className="mb-2">
                              Conecta tu canal de YouTube para recibir chat en vivo, Super Chats, miembros, suscriptores y alertas en los +57 overlays (solo YouTube o Multistream con Twitch).
                            </p>

                            {/* Mode selector tabs */}
                            <div className={styles.ytTabs}>
                              <button
                                type="button"
                                onClick={() => { setYtMode('apikey'); setYtError(''); }}
                                className={`${styles.ytTabBtn} ${ytMode === 'apikey' ? styles.ytTabBtnActive : ''}`}
                              >
                                ⚡ Conexión Rápida (API Key)
                              </button>
                              <button
                                type="button"
                                onClick={() => { setYtMode('oauth'); setYtError(''); }}
                                className={`${styles.ytTabBtn} ${ytMode === 'oauth' ? styles.ytTabBtnActive : ''}`}
                              >
                                🔐 OAuth 2.0 Completo
                              </button>
                            </div>

                            {ytMode === 'apikey' ? (
                              <div className={styles.ytForm}>
                                <div className={styles.ytField}>
                                  <label className={styles.ytFieldLabel}>
                                    YouTube Data API v3 Key
                                    {youtubeCredentials?.hasApiKey && (
                                      <span className={styles.savedKeyHint}>
                                        ✓ Guardada ({youtubeCredentials.apiKeyPreview})
                                      </span>
                                    )}
                                  </label>
                                  <input
                                    type="password"
                                    value={ytApiKey}
                                    onChange={(e) => setYtApiKey(e.target.value)}
                                    placeholder={
                                      youtubeCredentials?.hasApiKey
                                        ? 'Dejar vacío para usar la API Key guardada o pega una nueva...'
                                        : 'AIzaSy...'
                                    }
                                    className="sf-input"
                                    style={{ fontSize: '0.78rem' }}
                                  />
                                </div>

                                <div className={styles.ytField}>
                                  <label className={styles.ytFieldLabel}>
                                    Canal de YouTube (@handle o ID de canal)
                                  </label>
                                  <input
                                    type="text"
                                    value={ytChannelInput}
                                    onChange={(e) => setYtChannelInput(e.target.value)}
                                    placeholder="@TuCanal o UCxxxxxxxxxxxx"
                                    className="sf-input"
                                    style={{ fontSize: '0.78rem' }}
                                  />
                                </div>

                                <div className={styles.connectBtnWrap}>
                                  <button
                                    type="button"
                                    disabled={ytBusy}
                                    onClick={handleQuickConnectYt}
                                    className={`sf-btn ${styles.youtubeBtn}`}
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                                    </svg>
                                    {ytBusy ? 'Conectando...' : 'Conectar Canal de YouTube'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setShowYtHelp((v) => !v)}
                                    className={styles.helpToggleBtn}
                                  >
                                    {showYtHelp ? 'Ocultar guía' : '¿Cómo obtener API Key?'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className={styles.ytForm}>
                                <div className={styles.ytField}>
                                  <label className={styles.ytFieldLabel}>
                                    Google OAuth Client ID
                                    {youtubeCredentials?.hasClientId && (
                                      <span className={styles.savedKeyHint}>
                                        ✓ Guardado ({youtubeCredentials.clientIdPreview})
                                      </span>
                                    )}
                                  </label>
                                  <input
                                    type="text"
                                    value={ytClientId}
                                    onChange={(e) => setYtClientId(e.target.value)}
                                    placeholder={
                                      youtubeCredentials?.hasClientId
                                        ? 'Dejar vacío para usar el Client ID guardado...'
                                        : '123456789-xxxx.apps.googleusercontent.com'
                                    }
                                    className="sf-input"
                                    style={{ fontSize: '0.78rem' }}
                                  />
                                </div>

                                <div className={styles.ytField}>
                                  <label className={styles.ytFieldLabel}>
                                    Google OAuth Client Secret
                                    {youtubeCredentials?.hasClientSecret && (
                                      <span className={styles.savedKeyHint}>✓ Guardado</span>
                                    )}
                                  </label>
                                  <input
                                    type="password"
                                    value={ytClientSecret}
                                    onChange={(e) => setYtClientSecret(e.target.value)}
                                    placeholder={
                                      youtubeCredentials?.hasClientSecret
                                        ? 'Dejar vacío para usar el Secret guardado...'
                                        : 'GOCSPX-...'
                                    }
                                    className="sf-input"
                                    style={{ fontSize: '0.78rem' }}
                                  />
                                </div>

                                <div className={styles.redirectUriBox}>
                                  <span className={styles.redirectUriLabel}>Redirect URI:</span>
                                  <code className={styles.redirectUriCode}>{redirectUri}</code>
                                  <button
                                    type="button"
                                    onClick={copyRedirectUri}
                                    className={styles.copyUriBtn}
                                  >
                                    {copiedUri ? '✓ Copiado' : 'Copiar'}
                                  </button>
                                </div>

                                <div className={styles.connectBtnWrap}>
                                  <button
                                    type="button"
                                    disabled={ytBusy}
                                    onClick={handleOAuthConnectYt}
                                    className={`sf-btn ${styles.youtubeBtn}`}
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                                    </svg>
                                    {ytBusy ? 'Abriendo Google...' : 'Autorizar con Google / YouTube'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setShowYtHelp((v) => !v)}
                                    className={styles.helpToggleBtn}
                                  >
                                    {showYtHelp ? 'Ocultar guía' : '¿Cómo configurar OAuth?'}
                                  </button>
                                </div>
                              </div>
                            )}

                            {showYtHelp && (
                              <div className={styles.ytHelpBox}>
                                <strong>Guía rápida en Google Cloud Console:</strong>
                                <ol>
                                  <li>Abre <strong>console.cloud.google.com</strong>, crea un proyecto y habilita <strong>YouTube Data API v3</strong>.</li>
                                  <li>Para <strong>Conexión Rápida</strong>: ve a <em>Credenciales → Crear credenciales → Clave de API</em> y pégala arriba junto con tu <code>@handle</code>.</li>
                                  <li>Para <strong>OAuth 2.0 Completo</strong> (enviar mensajes desde el Dashboard y moderar): crea un <em>ID de cliente OAuth (Aplicación web)</em>, añade <code>{redirectUri}</code> en URI de redirección autorizados y pega el Client ID y Secret.</li>
                                </ol>
                              </div>
                            )}

                            {ytError && (
                              <p className={styles.errorText}>{ytError}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {step.comingSoon && (
                      <p className={styles.comingSoonDesc}>
                        {t('setup.tiktokDesc')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Finish button */}
        <button
          onClick={handleFinish}
          disabled={!authenticated}
          className={`sf-btn ${styles.finishBtn} ${authenticated ? styles['finishBtn--ready'] : styles['finishBtn--disabled']}`}
        >
          {authenticated ? t('setup.start') : t('setup.connectFirst')}
        </button>
      </div>
    </div>
  );
}
