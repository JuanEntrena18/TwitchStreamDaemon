import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export interface TtsFilters {
  excludeOwn: boolean;
  excludeLinks: boolean;
  excludeBots: boolean;
  botNames: string;
  readAuthor: boolean;
}

interface TtsContextValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  engine: 'native' | 'piper';
  setEngine: (v: 'native' | 'piper') => void;
  piperLang: 'es' | 'en';
  setPiperLang: (v: 'es' | 'en') => void;
  voiceURI: string | null;
  setVoiceURI: (v: string | null) => void;
  rate: number;
  setRate: (v: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  filters: TtsFilters;
  setFilters: (f: TtsFilters) => void;
  currentUserId: string | null;
  setCurrentUserId: (id: string | null) => void;
}

const defaultFilters: TtsFilters = { excludeOwn: false, excludeLinks: false, excludeBots: false, botNames: '', readAuthor: false };
const TTS_STORAGE_KEY = 'streamdaemon-tts-settings';

function loadSavedTts() {
  try {
    const raw = localStorage.getItem(TTS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

const TtsContext = createContext<TtsContextValue>({
  enabled: false,
  setEnabled: () => {},
  engine: 'native',
  setEngine: () => {},
  piperLang: 'es',
  setPiperLang: () => {},
  voiceURI: null,
  setVoiceURI: () => {},
  rate: 1,
  setRate: () => {},
  volume: 1,
  setVolume: () => {},
  filters: defaultFilters,
  setFilters: () => {},
  currentUserId: null,
  setCurrentUserId: () => {},
});

export function TtsProvider({ children }: { children: ReactNode }) {
  const initial = loadSavedTts();
  const [enabled, setEnabled] = useState<boolean>(() => Boolean(initial.enabled ?? false));
  const [engine, setEngine] = useState<'native' | 'piper'>(() => (initial.engine === 'piper' ? 'piper' : 'native'));
  const [piperLang, setPiperLang] = useState<'es' | 'en'>(() => (initial.piperLang === 'en' ? 'en' : 'es'));
  const [voiceURI, setVoiceURI] = useState<string | null>(() => initial.voiceURI ?? null);
  const [rate, setRate] = useState<number>(() => (typeof initial.rate === 'number' ? initial.rate : 1));
  const [volume, setVolume] = useState<number>(() => (typeof initial.volume === 'number' ? initial.volume : 1));
  const [filters, setFilters] = useState<TtsFilters>(() => ({ ...defaultFilters, ...(initial.filters || {}) }));
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        TTS_STORAGE_KEY,
        JSON.stringify({ enabled, engine, piperLang, voiceURI, rate, volume, filters }),
      );
    } catch {}
  }, [enabled, engine, piperLang, voiceURI, rate, volume, filters]);

  return (
    <TtsContext.Provider value={{
      enabled, setEnabled, 
      engine, setEngine,
      piperLang, setPiperLang,
      voiceURI, setVoiceURI, rate, setRate, volume, setVolume,
      filters, setFilters, currentUserId, setCurrentUserId,
    }}>
      {children}
    </TtsContext.Provider>
  );
}

export function useTts() {
  return useContext(TtsContext);
}
