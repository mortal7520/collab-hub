import { EventEmitter } from 'node:events';

/**
 * Lightweight in-process pub/sub bus for real-time SSE notifications on :5290.
 */
class HubEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  publish(type, payload = {}) {
    this.emit('hub-event', {
      type,
      at: new Date().toISOString(),
      ...payload,
    });
  }
}

export const hubBus = new HubEventBus();
