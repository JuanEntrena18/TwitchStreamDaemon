import { useEffect, useRef, useCallback } from 'react';
import { useSocketEvent } from '../hooks/useSocket';
import { useTts } from '../contexts/TtsContext';
import { speak, cancelAll } from '../utils/tts';

interface ChatMsg {
  id: string;
  platform?: 'twitch' | 'youtube';
  isHistory?: boolean;
  user: { id: string; username?: string; displayName: string; color: string; badges: string[] };
  text: string;
  timestamp: number;
}

function shouldSkip(
  msg: ChatMsg,
  currentUserId: string | null,
  filters: { excludeOwn: boolean; excludeLinks: boolean; excludeBots: boolean; botNames: string },
) {
  if (msg.isHistory) return true;
  if (!msg.text || msg.text.trim().startsWith('!')) return true;
  if (
    filters.excludeOwn &&
    (msg.user.badges?.includes('broadcaster') || (currentUserId && msg.user.id === currentUserId))
  ) {
    return true;
  }
  if (filters.excludeLinks && /https?:\/\//i.test(msg.text)) return true;
  if (filters.excludeBots && filters.botNames) {
    const names = filters.botNames.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
    const disp = (msg.user.displayName || '').toLowerCase();
    const uname = (msg.user.username || '').toLowerCase();
    if (names.includes(disp) || (uname && names.includes(uname))) return true;
  }
  return false;
}

const DEDUP_WINDOW = 30;

export function TtsManager() {
  const { enabled, voiceURI, rate, volume, engine, piperLang, filters, currentUserId } = useTts();
  const recentIdsRef = useRef<string[]>([]);

  useSocketEvent('chat:message', useCallback((msg: ChatMsg) => {
    if (!enabled) return;
    const dedupKey = msg.id || `${msg.user?.displayName}:${msg.text}:${msg.timestamp}`;
    if (recentIdsRef.current.includes(dedupKey)) return;
    if (shouldSkip(msg, currentUserId, filters)) return;
    recentIdsRef.current.push(dedupKey);
    if (recentIdsRef.current.length > DEDUP_WINDOW) recentIdsRef.current.shift();
    const textToSpeak = filters.readAuthor ? `${msg.user.displayName}: ${msg.text}` : msg.text;
    speak(textToSpeak, voiceURI, rate, volume, engine, piperLang);
  }, [enabled, voiceURI, rate, volume, engine, piperLang, filters, currentUserId]));

  useEffect(() => {
    if (!enabled) cancelAll();
  }, [enabled]);

  return null;
}
