import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n/context';
import { useSocketEvent } from './useSocket';
import { apiGet, apiPost, apiPut } from '../utils/api';

export interface AuthUser {
  id: string;
  twitchId: string;
  login: string;
  displayName: string;
  profileImageUrl?: string;
}

export interface YouTubeCredentialsStatus {
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasApiKey: boolean;
  clientIdPreview?: string;
  apiKeyPreview?: string;
  redirectUri: string;
}

export interface AuthStatus {
  authenticated: boolean;
  twitchAuthenticated?: boolean;
  youtubeAuthenticated?: boolean;
  youtubeAuthMode?: 'oauth' | 'apikey' | null;
  user: AuthUser | null;
  twitchUser?: AuthUser | null;
  youtubeUser?: AuthUser | null;
  youtubeCredentials?: YouTubeCredentialsStatus;
}

export interface DeviceCodeState {
  status: 'idle' | 'loading' | 'polling';
  userCode?: string;
  verificationUri?: string;
  deviceCode?: string;
  interval?: number;
  error?: string;
}

export function useAuthStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AuthStatus>({
    authenticated: false,
    twitchAuthenticated: false,
    youtubeAuthenticated: false,
    youtubeAuthMode: null,
    user: null,
    twitchUser: null,
    youtubeUser: null,
  });
  const [loading, setLoading] = useState(true);
  const [deviceState, setDeviceState] = useState<DeviceCodeState>({ status: 'idle' });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet('/auth/status');
      if (res.ok) {
        const data: AuthStatus = await res.json();
        setStatus(data);
        if (data.twitchAuthenticated) {
          setDeviceState({ status: 'idle' });
        }
      }
    } catch {
      // Backend not ready yet — keep previous state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();

    if (status.authenticated) {
      const id = setInterval(refresh, 60000);
      return () => clearInterval(id);
    }
  }, [refresh, status.authenticated]);

  useEffect(() => {
    const handleExpired = () => {
      setStatus((prev) => ({
        ...prev,
        authenticated: Boolean(prev.youtubeAuthenticated),
        twitchAuthenticated: false,
        twitchUser: null,
      }));
      setDeviceState({ status: 'idle' });
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  useSocketEvent('auth:changed', refresh);

  const startDeviceLogin = useCallback(async () => {
    setDeviceState({ status: 'loading' });
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await apiPost('/auth/device');

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setDeviceState({ status: 'idle', error: err.error || t('auth.errorLogin') });
          return;
        }
        const data = await res.json();
        setDeviceState({
          status: 'polling',
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          deviceCode: data.device_code,
          interval: data.interval,
        });
        return;
      } catch {
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        setDeviceState({ status: 'idle', error: t('auth.errorNetwork') });
      }
    }
  }, [t]);

  useEffect(() => {
    if (deviceState.status !== 'polling' || !deviceState.deviceCode) return;

    let cancelled = false;
    const intervalMs = Math.max(2000, (deviceState.interval || 5) * 1000);

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await apiPost('/auth/device/poll', { device_code: deviceState.deviceCode });

        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (data.status === 'authenticated') {
          setDeviceState({ status: 'idle' });
          await refresh();
          return;
        }

        // If Twitch explicitly expired the token or user denied
        if (data.error === 'expired_token' || data.error === 'access_denied') {
          setDeviceState({
            status: 'idle',
            error: data.error === 'expired_token'
              ? t('auth.errorExpired')
              : t('auth.errorDenied'),
          });
          return;
        }

        // If backend returned an error status, check if user got authenticated anyway
        if (data.status === 'error') {
          const checkRes = await apiGet('/auth/status');
          if (checkRes.ok) {
            const checkData = await checkRes.json().catch(() => ({}));
            if (checkData.twitchAuthenticated) {
              setStatus(checkData);
              setDeviceState({ status: 'idle' });
              return;
            }
          }
        }
      } catch {
        // Network error during poll — keep polling
      }
      if (!cancelled) {
        timeoutRef.current = setTimeout(poll, intervalMs);
      }
    };

    timeoutRef.current = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [deviceState.status, deviceState.deviceCode, deviceState.interval, refresh, t]);

  const cancelDeviceLogin = useCallback(() => {
    setDeviceState({ status: 'idle' });
  }, []);

  const login = useCallback(() => {
    startDeviceLogin();
  }, [startDeviceLogin]);

  const logout = useCallback(async () => {
    try {
      await apiPost('/auth/logout');
    } catch { /* ignore */ }
    await refresh();
  }, [refresh]);

  // ── YouTube Actions ──

  const saveYouTubeCredentials = useCallback(async (creds: { clientId?: string; clientSecret?: string; apiKey?: string }) => {
    const res = await apiPut('/youtube/credentials', creds);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error al guardar credenciales de YouTube');
    await refresh();
    return data;
  }, [refresh]);

  const quickConnectYouTube = useCallback(async (channelHandleOrId: string, apiKey?: string) => {
    const res = await apiPost('/auth/youtube/quick-connect', { channelHandleOrId, apiKey });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error al conectar canal de YouTube');
    await refresh();
    return data;
  }, [refresh]);

  const startYouTubeOAuth = useCallback(async (creds?: { clientId?: string; clientSecret?: string }) => {
    if (creds && (creds.clientId || creds.clientSecret)) {
      await saveYouTubeCredentials(creds);
    }
    const res = await apiPost('/auth/youtube/start', {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authUrl) {
      throw new Error(data.error || 'Falta configurar Google Client ID y Client Secret');
    }
    window.open(data.authUrl, '_blank', 'noopener,noreferrer');
    return data;
  }, [saveYouTubeCredentials]);

  const logoutYouTube = useCallback(async () => {
    try {
      await apiPost('/auth/youtube/logout', {});
    } catch { /* ignore */ }
    await refresh();
  }, [refresh]);

  const simulateYouTubeEvent = useCallback(async (payload: {
    type: 'chat' | 'subscriber' | 'member' | 'milestone' | 'gift' | 'superchat';
    user?: string;
    message?: string;
    amount?: number;
    currency?: string;
    months?: number;
    count?: number;
  }) => {
    const res = await apiPost('/youtube/simulate-event', payload);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error al simular evento');
    return data;
  }, []);

  const fetchYouTubeStatus = useCallback(async () => {
    const res = await apiGet('/youtube/status');
    if (!res.ok) return null;
    return res.json();
  }, []);

  return {
    ...status,
    twitchAuthenticated: Boolean(status.twitchAuthenticated ?? (status.authenticated && status.twitchUser)),
    youtubeAuthenticated: Boolean(status.youtubeAuthenticated),
    loading,
    login,
    logout,
    deviceState,
    cancelDeviceLogin,
    refresh,
    saveYouTubeCredentials,
    quickConnectYouTube,
    startYouTubeOAuth,
    logoutYouTube,
    simulateYouTubeEvent,
    fetchYouTubeStatus,
  };
}
