import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getIO } from '../socket/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'fortnite-config.json');

interface FortniteConfig {
  apiKey: string;
  epicUsername: string;
  statsMode: string;
  layout: string;
}

const DEFAULT_CONFIG: FortniteConfig = { apiKey: '', epicUsername: '', statsMode: 'overall', layout: 'stats' };

interface FortniteApiStat {
  value?: number;
  [key: string]: unknown;
}

interface FortniteApiStats {
  all?: Record<string, FortniteApiStat | undefined>;
}

interface FortniteStatsResult {
  account: unknown;
  battlePass: unknown;
  mode: string;
  kills: number;
  wins: number;
  matches: number;
  kd: number;
  winRate: number;
  top10: number;
  top25: number;
  score: number;
  minutesPlayed: number;
  killsPerMatch: number;
}

let fortniteConfig: FortniteConfig = { ...DEFAULT_CONFIG };
const statsCache = new Map<string, { data: FortniteStatsResult; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function loadConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      fortniteConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
    if (!fortniteConfig.apiKey && config.FORTNITE_API_KEY) {
      fortniteConfig.apiKey = config.FORTNITE_API_KEY;
    }
  } catch (e) {
    console.warn('Failed to load fortnite-config.json', e);
  }
}

function saveConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(fortniteConfig, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Failed to save fortnite-config.json', e);
  }
}

loadConfig();

function getModeKey(mode: string): string {
  const m = mode.toLowerCase();
  if (['overall', 'solo', 'duo', 'trio', 'squad'].includes(m)) return m;
  return 'overall';
}

function getStat(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && typeof (v as FortniteApiStat).value === 'number') {
    return (v as FortniteApiStat).value ?? 0;
  }
  return 0;
}

async function fetchFortniteStats(rawUsername: string, mode: string): Promise<FortniteStatsResult> {
  const username = rawUsername.trim();
  const modeKey = getModeKey(mode);
  const cacheKey = `${username.toLowerCase()}:${modeKey}`;
  const cached = statsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const apiKey = (fortniteConfig.apiKey || config.FORTNITE_API_KEY || '').trim();
  if (!apiKey) throw new Error('API Key de Fortnite-API.com no configurada');

  let res = await fetch(
    `https://fortnite-api.com/v2/stats/br/v2?name=${encodeURIComponent(username)}&accountType=epic&timeWindow=lifetime`,
    { headers: { Authorization: apiKey } },
  );

  // Fallback without accountType=epic if user typed a console/display name
  if (res.status === 404) {
    res = await fetch(
      `https://fortnite-api.com/v2/stats/br/v2?name=${encodeURIComponent(username)}&timeWindow=lifetime`,
      { headers: { Authorization: apiKey } },
    );
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('API Key de Fortnite-API.com inválida o no autorizada (401).');
    }
    if (res.status === 403) {
      throw new Error('Las estadísticas de esta cuenta están en privado (403). Activa "Estadísticas de carrera públicas" en Fortnite.');
    }
    if (res.status === 404) {
      throw new Error(`No se encontró el jugador "${username}" en Fortnite-API.com (404).`);
    }
    const text = await res.text();
    throw new Error(`Fortnite API error ${res.status}: ${text}`);
  }

  const body = await res.json() as {
    status?: number;
    data?: {
      account?: unknown;
      battlePass?: unknown;
      stats?: FortniteApiStats;
    };
  };
  if (body.status !== 200 || !body.data) throw new Error('Respuesta inválida de Fortnite-API.com');

  const statsAll = body.data.stats?.all;
  if (!statsAll) throw new Error('No se encontraron estadísticas para este jugador');

  let modeStats = statsAll[modeKey];
  // Fall back to overall when mode-specific stats are all zero
  if (modeStats && modeKey !== 'overall') {
    const zero = !(getStat(modeStats?.kills) || getStat(modeStats?.wins) || getStat(modeStats?.matches));
    if (zero) modeStats = statsAll.overall;
  }
  if (!modeStats) modeStats = statsAll.overall;
  if (!modeStats) throw new Error('No se encontraron estadísticas para este jugador');

  const s = (k: string) => getStat(modeStats?.[k]);
  const result = {
    account: body.data.account,
    battlePass: body.data.battlePass,
    mode: modeKey,
    kills: s('kills'),
    wins: s('wins'),
    matches: s('matches'),
    kd: s('kd'),
    winRate: s('winRate'),
    top10: s('top10'),
    top25: s('top25'),
    score: s('score'),
    minutesPlayed: s('minutesPlayed'),
    killsPerMatch: s('killsPerMatch'),
  };

  statsCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

export function setupFortnite(app: FastifyInstance) {
  // Get current config
  app.get('/fortnite/config', () => ({
    apiKey: !!fortniteConfig.apiKey,
    epicUsername: fortniteConfig.epicUsername,
    statsMode: fortniteConfig.statsMode,
    layout: fortniteConfig.layout,
  }));

  // Update config
  app.put('/fortnite/config', async (req, reply) => {
    const { apiKey, epicUsername, statsMode, layout } = req.body as Partial<FortniteConfig>;
    if (apiKey !== undefined && apiKey.trim() !== '') fortniteConfig.apiKey = apiKey.trim();
    if (epicUsername !== undefined) fortniteConfig.epicUsername = epicUsername.trim();
    if (statsMode !== undefined) fortniteConfig.statsMode = statsMode;
    if (layout !== undefined) fortniteConfig.layout = layout;
    saveConfig();
    statsCache.clear();

    try {
      getIO()?.emit('fortnite:config', {
        epicUsername: fortniteConfig.epicUsername,
        statsMode: fortniteConfig.statsMode,
        layout: fortniteConfig.layout,
      });
    } catch {}

    let stats: FortniteStatsResult | null = null;
    let statsError: string | null = null;
    if (fortniteConfig.apiKey && fortniteConfig.epicUsername) {
      try {
        stats = await fetchFortniteStats(fortniteConfig.epicUsername, fortniteConfig.statsMode);
      } catch (err) {
        statsError = err instanceof Error ? err.message : String(err);
      }
    }

    reply.send({ ok: true, stats, statsError });
  });

  // Fetch stats for a player
  app.get('/fortnite/stats/:username', async (req, reply) => {
    const { username } = req.params as { username: string };
    const { mode } = req.query as { mode?: string };

    if (!username) return reply.status(400).send({ error: 'Missing username' });

    try {
      const data = await fetchFortniteStats(username, mode || fortniteConfig.statsMode);
      reply.send(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch Fortnite stats';
      reply.status(502).send({ error: message });
    }
  });
}
