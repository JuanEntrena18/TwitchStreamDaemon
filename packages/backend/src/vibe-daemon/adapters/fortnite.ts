import type { VibeDaemonEvent } from '@streamdaemon/shared';
import type { VibeDaemonAdapter } from '../index.js';
import { recordKill, recordDeath, recordVictory, getState, resetState } from '../state.js';

export interface FortniteAdapterOptions {
  channel: string;
}

export function createFortniteAdapter(_options: FortniteAdapterOptions): VibeDaemonAdapter {
  return {
    name: 'fortnite',
    async handleEvent(event: VibeDaemonEvent) {
      const ch = event.channel.toLowerCase();
      switch (event.eventType) {
        case 'kill':
          recordKill(ch, 'global');
          return recordKill(ch, 'fortnite');
        case 'death':
          recordDeath(ch, 'global');
          return recordDeath(ch, 'fortnite');
        case 'victory':
          recordVictory(ch, 'global');
          return recordVictory(ch, 'fortnite');
        default:
          return getState(ch, 'fortnite');
      }
    },
    async reset(channel: string, gameId: string) {
      const ch = channel.toLowerCase();
      resetState(ch, 'global');
      return resetState(ch, gameId);
    },
  };
}
