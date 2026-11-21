import type {
  VibeDaemonTrigger,
  VibeDaemonEvent,
  VibeDaemonActivation,
  VibeDaemonState,
  VibeDaemonGameId,
} from '@streamdaemon/shared';

const lastActivationByTrigger = new Map<string, number>();

function isCooldownExpired(trigger: VibeDaemonTrigger): boolean {
  const cooldown = trigger.cooldownMs ?? 0;
  if (cooldown <= 0) return true;
  const last = lastActivationByTrigger.get(trigger.id) ?? 0;
  return Date.now() - last >= cooldown;
}

function markActivated(trigger: VibeDaemonTrigger): void {
  lastActivationByTrigger.set(trigger.id, Date.now());
}

function getMetricValue(
  trigger: VibeDaemonTrigger,
  state: VibeDaemonState,
  event: VibeDaemonEvent,
): number {
  const period = trigger.condition.period ?? 'session';
  const metricType = trigger.eventType;

  if (metricType === 'kill_streak') return state.killStreak;
  if (metricType === 'victory_streak') return state.victoryStreak;

  switch (period) {
    case 'session':
      switch (metricType) {
        case 'kill':
          return state.kills;
        case 'death':
          return state.deaths;
        case 'victory':
          return state.victories;
        default:
          return event.value ?? 1;
      }
    case 'match':
    case 'round':
      switch (metricType) {
        case 'kill':
          return state.currentMatchKills;
        case 'death':
          return state.currentMatchDeaths;
        case 'victory':
          return state.victories;
        default:
          return event.value ?? 1;
      }
    case 'time_window': {
      const windowSeconds = trigger.condition.timeWindowSeconds ?? 60;
      const now = Date.now();
      let lastEventAt: number | null = null;
      switch (metricType) {
        case 'kill':
          lastEventAt = state.lastKillAt;
          break;
        case 'death':
          lastEventAt = state.lastDeathAt;
          break;
        case 'victory':
          lastEventAt = state.lastVictoryAt;
          break;
      }
      if (!lastEventAt) return 1;
      return now - lastEventAt <= windowSeconds * 1000 ? (event.value ?? 1) : 0;
    }
    default:
      return event.value ?? 1;
  }
}

export function evaluateTrigger(
  trigger: VibeDaemonTrigger,
  state: VibeDaemonState,
  event: VibeDaemonEvent,
): boolean {
  if (!trigger.enabled) return false;
  if (!isCooldownExpired(trigger)) return false;

  const eventGame = normalizeGameId(event.gameId);
  const triggerGame = normalizeGameId(trigger.gameId);
  if (triggerGame !== 'global' && triggerGame !== eventGame) return false;

  // Allow kill events to automatically evaluate kill_streak triggers,
  // and victory events to automatically evaluate victory_streak triggers!
  const directMatch = trigger.eventType === event.eventType;
  const streakMatch =
    (event.eventType === 'kill' && trigger.eventType === 'kill_streak') ||
    (event.eventType === 'victory' && trigger.eventType === 'victory_streak');

  if (!directMatch && !streakMatch) {
    return false;
  }

  const condition = trigger.condition;
  const value = getMetricValue(trigger, state, event);

  switch (condition.type) {
    case 'count': {
      const target = Math.max(1, condition.count ?? 1);
      if (target === 1) return value >= 1;
      // For streaks (e.g., 5+ kill streak), trigger when reaching target or every multiple
      if (streakMatch) return value >= target && value % target === 0;
      return value >= target && value % target === 0;
    }
    case 'threshold':
      return value >= (condition.threshold ?? 1);
    case 'state':
      // State events (low_shield, low_health, storm_shrinking) carry hysteresis & cooldown in CV detector
      return true;
    default:
      return false;
  }
}

export function buildActivation(
  trigger: VibeDaemonTrigger,
  channel: string,
  event: VibeDaemonEvent,
  state?: VibeDaemonState,
): VibeDaemonActivation {
  markActivated(trigger);
  const action = { ...trigger.action };
  if (action.message && state) {
    action.message = action.message
      .replace(/\{\{kills\}\}/g, String(state.kills))
      .replace(/\{\{killStreak\}\}/g, String(state.killStreak))
      .replace(/\{\{victories\}\}/g, String(state.victories))
      .replace(/\{\{victoryStreak\}\}/g, String(state.victoryStreak));
  }
  return {
    triggerId: trigger.id,
    triggerName: trigger.name,
    eventType: trigger.eventType,
    gameId: trigger.gameId,
    action,
    channel: channel.toLowerCase(),
    timestamp: Date.now(),
  };
}

export function normalizeGameId(gameName: string): VibeDaemonGameId {
  const normalized = gameName.toLowerCase().trim();
  if (normalized.includes('fortnite')) return 'fortnite';
  return normalized || 'global';
}
