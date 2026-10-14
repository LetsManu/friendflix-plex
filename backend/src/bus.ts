// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { MediaEvent } from './media/types.js';

/** In-process event bus: decouples features (achievements, stats) from the code that raises events. */
export interface BusEvents {
  'party.join': [{ userId: string; roomId: string }];
  'party.chat': [{ userId: string; roomId: string }];
  'rating.created': [{ userId: string }];
  'request.created': [{ userId: string }];
  /** neutral media server event, after media/events.ts handled it */
  'media.event': [MediaEvent];
}
class TypedBus extends EventEmitter {
  emitT<K extends keyof BusEvents>(k: K, ...a: BusEvents[K]) {
    return this.emit(k, ...a);
  }
  onT<K extends keyof BusEvents>(k: K, fn: (...a: BusEvents[K]) => void) {
    return this.on(k, fn as (...a: unknown[]) => void);
  }
}
export const bus = new TypedBus();
