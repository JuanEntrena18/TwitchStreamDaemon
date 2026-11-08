import { useEffect, useState, useCallback, useRef } from 'react';
import { useSocket, useSocketEvent } from '../hooks/useSocket';
import { useTranslation } from '../i18n/context';
import { speak, getVoices, cancelAll } from '../utils/tts';
import type { ChatMessage } from '@streamdaemon/shared';
import styles from './CyanChatOverlay.module.css';

interface Props {
  channel: string;
}

const LS_KEY = 'cyanChatUrl';
const TTS_LS_KEY = 'streamforger-overlay-tts';
const MAX_YT_MESSAGES = 12;

function loadTtsSettings() {
  try {
    const raw = localStorage.getItem(TTS_LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveTtsSettings(s: Record<string, unknown>) {
  try {
    localStorage.setItem(TTS_LS_KEY, JSON.stringify(s));
  } catch {}
}

export function normalizeCyanChatUrl(rawUrl: string, fallbackChannel: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed) {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return `https://${trimmed}`;
  }
  if (fallbackChannel.trim()) {
    return `https://chat.johnnycyan.com/?channel=${encodeURIComponent(fallbackChannel.trim())}`;
  }
  return '';
}

function getCyanChatUrl(channel: string): string {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('cyanUrl') || '';
  if (fromParam.trim()) {
    const normalized = normalizeCyanChatUrl(fromParam, channel);
    try {
      localStorage.setItem(LS_KEY, normalized);
    } catch {}
    return normalized;
  }
  let fromLS = '';
  try {
    fromLS = localStorage.getItem(LS_KEY) || '';
  } catch {}
  return normalizeCyanChatUrl(fromLS, channel);
}

export function CyanChatOverlay({ channel }: Props) {
  const { t } = useTranslation();
  const { socket } = useSocket();
  const [url, setUrl] = useState(() => getCyanChatUrl(channel));
  const [ytMessages, setYtMessages] = useState<ChatMessage[]>([]);
  const recentTtsIdsRef = useRef<string[]>([]);

  const tls = loadTtsSettings();
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => tls.enabled ?? false);
  const [ttsVoiceURI, setTtsVoiceURI] = useState<string | null>(() => tls.voiceURI ?? null);
  const [ttsRate, setTtsRate] = useState<number>(() => tls.rate ?? 1);
  const [ttsVolume, setTtsVolume] = useState<number>(() => tls.volume ?? 1);
  const [ttsEngine, setTtsEngine] = useState<'native' | 'piper'>(() => tls.engine ?? 'native');
  const [ttsPiperLang, setTtsPiperLang] = useState<'es' | 'en'>(() => tls.piperLang ?? 'es');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    setUrl(getCyanChatUrl(channel));
  }, [channel]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY) {
        setUrl(normalizeCyanChatUrl(e.newValue || '', channel));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [channel]);

  useEffect(() => {
    if (!window.speechSynthesis) return;
    const update = () => setVoices(getVoices());
    update();
    window.speechSynthesis.onvoiceschanged = update;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const join = () => socket.emit('join:channel', channel || 'global');
    join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
    };
  }, [channel, socket]);

  useSocketEvent(
    'chat:message',
    useCallback(
      (msg: ChatMessage & { isHistory?: boolean }) => {
        if (msg.platform === 'youtube') {
          setYtMessages((prev) => [...prev.slice(-MAX_YT_MESSAGES + 1), msg]);
        }
        if (msg.isHistory) return;
        if (ttsEnabled && msg.text && !msg.text.startsWith('!')) {
          const dedupKey = msg.id || `${msg.user?.displayName}:${msg.text}:${msg.timestamp}`;
          if (!recentTtsIdsRef.current.includes(dedupKey)) {
            recentTtsIdsRef.current.push(dedupKey);
            if (recentTtsIdsRef.current.length > 30) recentTtsIdsRef.current.shift();
            speak(msg.text, ttsVoiceURI, ttsRate, ttsVolume, ttsEngine, ttsPiperLang);
          }
        }
      },
      [ttsEnabled, ttsVoiceURI, ttsRate, ttsVolume, ttsEngine, ttsPiperLang],
    ),
  );

  function toggleTts() {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    saveTtsSettings({ ...loadTtsSettings(), enabled: next });
    if (!next) cancelAll();
  }

  function changeVoice(uri: string) {
    const val = uri || null;
    setTtsVoiceURI(val);
    saveTtsSettings({ ...loadTtsSettings(), voiceURI: val });
  }

  function changeEngine(eng: 'native' | 'piper') {
    setTtsEngine(eng);
    saveTtsSettings({ ...loadTtsSettings(), engine: eng });
  }

  function changePiperLang(lang: 'es' | 'en') {
    setTtsPiperLang(lang);
    saveTtsSettings({ ...loadTtsSettings(), piperLang: lang });
  }

  function changeRate(r: number) {
    setTtsRate(r);
    saveTtsSettings({ ...loadTtsSettings(), rate: r });
  }

  function changeVolume(v: number) {
    setTtsVolume(v);
    saveTtsSettings({ ...loadTtsSettings(), volume: v });
  }

  return (
    <div className={styles.wrapper}>
      {/* Compact TTS Control Bar for Twitch + YouTube */}
      <div className={styles.ttsBar}>
        <button
          type="button"
          onClick={toggleTts}
          className={`${styles.ttsToggle} ${ttsEnabled ? styles.ttsToggleOn : ''}`}
        >
          {ttsEnabled ? t('overlay.ttsOn') : t('overlay.ttsOff')}
        </button>

        <select
          value={ttsEngine}
          onChange={(e) => changeEngine(e.target.value as 'native' | 'piper')}
          className={styles.ttsSelectSmall}
        >
          <option value="native">Win</option>
          <option value="piper">Piper</option>
        </select>

        {ttsEngine === 'native' ? (
          <select
            value={ttsVoiceURI ?? ''}
            onChange={(e) => changeVoice(e.target.value)}
            className={styles.ttsSelectVoice}
          >
            <option value="">{t('overlay.voz')}</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}
              </option>
            ))}
          </select>
        ) : (
          <select
            value={ttsPiperLang}
            onChange={(e) => changePiperLang(e.target.value as 'es' | 'en')}
            className={styles.ttsSelectSmall}
          >
            <option value="es">ES</option>
            <option value="en">EN</option>
          </select>
        )}

        <span className={styles.ttsLabel}>{t('overlay.vel')}</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={ttsRate}
          onChange={(e) => changeRate(parseFloat(e.target.value))}
          className={styles.ttsRange}
        />

        <span className={styles.ttsLabel}>{t('overlay.vol')}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={ttsVolume}
          onChange={(e) => changeVolume(parseFloat(e.target.value))}
          className={styles.ttsRange}
        />

        <button
          type="button"
          onClick={() => cancelAll()}
          className={styles.ttsStopBtn}
          title={t('overlay.detener')}
        >
          ✕
        </button>
      </div>

      {!url ? (
        <div className={styles.loading}>
          No hay URL de Cyan Chat configurada.
          <br />
          Configúrala desde el panel de Chat o Ventana Transparente.
        </div>
      ) : (
        <iframe
          key={url}
          src={url}
          className={styles.iframe}
          title="Cyan Chat"
          allow="autoplay; clipboard-write"
        />
      )}

      {/* Multistream YouTube Live Chat Overlay Feed (complements JohnnyCyan Twitch IRC) */}
      {ytMessages.length > 0 && (
        <div className={styles.ytFeed}>
          {ytMessages.slice(-4).map((msg) => (
            <div key={msg.id} className={styles.ytMsg}>
              <span className={styles.ytBadge}>YT</span>
              {msg.superChat?.formattedAmount && (
                <span
                  className={styles.scBadge}
                  style={{ background: msg.superChat.tierColor || '#ffb300' }}
                >
                  SC {msg.superChat.formattedAmount}
                </span>
              )}
              <span className={styles.ytUser} style={{ color: msg.user.color || '#ff4e45' }}>
                {msg.user.displayName}:
              </span>
              <span className={styles.ytText}>{msg.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
