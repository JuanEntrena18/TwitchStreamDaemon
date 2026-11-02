import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getIO } from '../socket/index.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const CONFIG_FILE = path.join(DATA_DIR, 'wow-config.json');

export interface WowCustomRow {
  label: string;
  value: string;
  tone?: 'gold' | 'arcane' | 'emerald' | 'ivory';
}

export interface WowConfig {
  mode: 'raiderio' | 'manual';
  region: 'eu' | 'us' | 'kr' | 'tw';
  realm: string;
  character: string;
  panelTitle: string;
  panelBadge: string;
  customRows: [WowCustomRow, WowCustomRow, WowCustomRow, WowCustomRow];
}

export interface WowStatsResponse {
  mode: 'raiderio' | 'manual';
  source: 'raiderio' | 'manual';
  panelTitle: string;
  panelBadge: string;
  character?: {
    name: string;
    realm: string;
    region: string;
    className?: string;
    specName?: string;
    faction?: string;
    thumbnailUrl?: string;
    profileUrl?: string;
  };
  rows: WowCustomRow[];
  error?: string;
}

const DEFAULT_CUSTOM_ROWS: [WowCustomRow, WowCustomRow, WowCustomRow, WowCustomRow] = [
  { label: 'Nivel de Objeto (iLvl)', value: '639 Mythic', tone: 'gold' },
  { label: 'Piedra Angular M+', value: '+16 En Tiempo', tone: 'arcane' },
  { label: 'Índice Mítico (RIO)', value: '3,480', tone: 'gold' },
  { label: 'Progreso de Banda', value: '8/8 Mítico', tone: 'emerald' },
];

const DEFAULT_CONFIG: WowConfig = {
  mode: 'manual',
  region: 'eu',
  realm: '',
  character: '',
  panelTitle: 'Crónicas de Azeroth',
  panelBadge: 'FOREVER',
  customRows: DEFAULT_CUSTOM_ROWS,
};

let wowConfig: WowConfig = { ...DEFAULT_CONFIG };
const statsCache = new Map<string, { data: WowStatsResponse; expiresAt: number }>();
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function loadConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WowConfig>;
      wowConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        customRows:
          Array.isArray(parsed.customRows) && parsed.customRows.length === 4
            ? (parsed.customRows as [WowCustomRow, WowCustomRow, WowCustomRow, WowCustomRow])
            : DEFAULT_CUSTOM_ROWS,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load wow-config.json');
  }
}

function saveConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(wowConfig, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Failed to save wow-config.json');
  }
}

loadConfig();

interface RaiderIoBestRun {
  dungeon?: string;
  short_name?: string;
  mythic_level?: number;
  num_keystone_upgrades?: number;
}

interface RaiderIoRaidEntry {
  summary?: string;
  total_bosses?: number;
  normal_bosses_killed?: number;
  heroic_bosses_killed?: number;
  mythic_bosses_killed?: number;
}

interface RaiderIoProfileResponse {
  name?: string;
  class?: string;
  active_spec_name?: string;
  faction?: string;
  region?: string;
  realm?: string;
  thumbnail_url?: string;
  profile_url?: string;
  gear?: {
    item_level_equipped?: number;
    item_level_total?: number;
  };
  mythic_plus_scores_by_season?: Array<{
    scores?: {
      all?: number;
    };
  }>;
  mythic_plus_best_runs?: RaiderIoBestRun[];
  raid_progression?: Record<string, RaiderIoRaidEntry>;
  message?: string;
}

function normalizeRealmSlug(realm: string): string {
  return realm
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-');
}

async function fetchRaiderIoProfile(region: string, realm: string, character: string): Promise<WowStatsResponse> {
  const cleanRegion = (region || 'eu').toLowerCase();
  const cleanRealm = normalizeRealmSlug(realm);
  const cleanChar = character.trim();

  const cacheKey = `${cleanRegion}:${cleanRealm}:${cleanChar.toLowerCase()}`;
  const cached = statsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const fields = 'gear,mythic_plus_scores_by_season:current,mythic_plus_best_runs,raid_progression';
  const url = `https://raider.io/api/v1/characters/profile?region=${encodeURIComponent(cleanRegion)}&realm=${encodeURIComponent(cleanRealm)}&name=${encodeURIComponent(cleanChar)}&fields=${encodeURIComponent(fields)}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(errBody.message || `Raider.IO devolvió estado ${res.status} para ${cleanChar} (${realm.toUpperCase()})`);
  }

  const data = (await res.json()) as RaiderIoProfileResponse;

  const ilvl = data.gear?.item_level_equipped
    ? `${Math.round(data.gear.item_level_equipped)} iLvl`
    : '—';

  const bestRun = data.mythic_plus_best_runs?.[0];
  const keystoneText = bestRun?.mythic_level
    ? `+${bestRun.mythic_level} ${bestRun.short_name || bestRun.dungeon || ''}${bestRun.num_keystone_upgrades ? ` (${'+'.repeat(bestRun.num_keystone_upgrades)})` : ''}`.trim()
    : data.active_spec_name && data.class
      ? `${data.active_spec_name} ${data.class}`
      : 'Sin M+ esta temp.';

  const rioScore = data.mythic_plus_scores_by_season?.[0]?.scores?.all ?? 0;
  const rioText = rioScore > 0 ? `${Math.round(rioScore).toLocaleString()} RIO` : '0 RIO';

  const raidEntries = data.raid_progression ? Object.values(data.raid_progression) : [];
  const latestRaid = raidEntries[raidEntries.length - 1];
  const raidText = latestRaid?.summary || 'Sin registro';

  const result: WowStatsResponse = {
    mode: 'raiderio',
    source: 'raiderio',
    panelTitle: wowConfig.panelTitle || `${data.name || cleanChar} · ${data.realm || realm}`,
    panelBadge: `${cleanRegion.toUpperCase()} · RIO`,
    character: {
      name: data.name || cleanChar,
      realm: data.realm || realm,
      region: cleanRegion.toUpperCase(),
      className: data.class,
      specName: data.active_spec_name,
      faction: data.faction,
      thumbnailUrl: data.thumbnail_url,
      profileUrl: data.profile_url,
    },
    rows: [
      { label: 'Nivel de Objeto (iLvl)', value: ilvl, tone: 'gold' },
      { label: 'Piedra Angular M+', value: keystoneText, tone: 'arcane' },
      { label: 'Índice Mítico (RIO)', value: rioText, tone: 'gold' },
      { label: 'Progreso de Banda', value: raidText, tone: 'emerald' },
    ],
  };

  statsCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

export async function resolveWowStats(overrides?: {
  mode?: 'raiderio' | 'manual';
  region?: string;
  realm?: string;
  character?: string;
}): Promise<WowStatsResponse> {
  const mode = overrides?.mode || wowConfig.mode;
  const region = overrides?.region || wowConfig.region;
  const realm = overrides?.realm !== undefined ? overrides.realm : wowConfig.realm;
  const character = overrides?.character !== undefined ? overrides.character : wowConfig.character;

  if (mode === 'raiderio' && realm.trim() && character.trim()) {
    try {
      return await fetchRaiderIoProfile(region, realm, character);
    } catch (err) {
      return {
        mode: 'raiderio',
        source: 'manual',
        panelTitle: wowConfig.panelTitle || 'Crónicas de Azeroth',
        panelBadge: wowConfig.panelBadge || 'FOREVER',
        rows: wowConfig.customRows,
        error: err instanceof Error ? err.message : 'Error consultando Raider.IO',
      };
    }
  }

  return {
    mode: 'manual',
    source: 'manual',
    panelTitle: wowConfig.panelTitle || 'Crónicas de Azeroth',
    panelBadge: wowConfig.panelBadge || 'FOREVER',
    character: character.trim()
      ? {
          name: character.trim(),
          realm: realm.trim() || 'Azeroth',
          region: region.toUpperCase(),
        }
      : undefined,
    rows: wowConfig.customRows,
  };
}

export function setupWow(app: FastifyInstance) {
  app.get('/wow/config', async () => {
    return wowConfig;
  });

  app.put('/wow/config', async (req, reply) => {
    const body = req.body as Partial<WowConfig>;
    if (body.mode === 'raiderio' || body.mode === 'manual') {
      wowConfig.mode = body.mode;
    }
    if (body.region && ['eu', 'us', 'kr', 'tw'].includes(body.region)) {
      wowConfig.region = body.region;
    }
    if (body.realm !== undefined) wowConfig.realm = body.realm.trim();
    if (body.character !== undefined) wowConfig.character = body.character.trim();
    if (body.panelTitle !== undefined) wowConfig.panelTitle = body.panelTitle.trim() || 'Crónicas de Azeroth';
    if (body.panelBadge !== undefined) wowConfig.panelBadge = body.panelBadge.trim() || 'FOREVER';
    if (Array.isArray(body.customRows) && body.customRows.length === 4) {
      wowConfig.customRows = body.customRows.map((r, idx) => ({
        label: String(r.label ?? DEFAULT_CUSTOM_ROWS[idx].label).trim() || DEFAULT_CUSTOM_ROWS[idx].label,
        value: String(r.value ?? DEFAULT_CUSTOM_ROWS[idx].value).trim() || DEFAULT_CUSTOM_ROWS[idx].value,
        tone: r.tone || DEFAULT_CUSTOM_ROWS[idx].tone,
      })) as [WowCustomRow, WowCustomRow, WowCustomRow, WowCustomRow];
    }

    statsCache.clear();
    saveConfig();

    const resolved = await resolveWowStats();
    try {
      getIO().emit('wow:stats-updated', resolved);
    } catch {}

    return reply.send({ ok: true, config: wowConfig, stats: resolved });
  });

  app.get('/wow/stats', async (req) => {
    const q = req.query as {
      mode?: 'raiderio' | 'manual';
      region?: string;
      realm?: string;
      character?: string;
    };
    return resolveWowStats(q);
  });
}

