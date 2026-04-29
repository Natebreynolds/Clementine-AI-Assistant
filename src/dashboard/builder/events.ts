/**
 * Builder event bus.
 *
 * Decouples MCP tool handlers (which mutate workflows) from the dashboard
 * WebSocket server (which streams updates to open builder tabs). Tools
 * call `emitBuilderEvent(...)` after a successful write; the WS server
 * subscribes and forwards to clients in the matching workflow room.
 *
 * Test-side / runs (Phase 2+) will reuse the same bus to stream per-step
 * status during long-running test/dry-run flows.
 */

import { EventEmitter } from 'node:events';

export type BuilderEventType =
  | 'workflow:created'
  | 'workflow:updated'
  | 'workflow:deleted'
  | 'workflow:renamed'
  | 'workflow:enabled-changed'
  | 'workflow:patched'      // generic save/patch event with full new state
  | 'run:started'
  | 'run:step-status'
  | 'run:step-output'
  | 'run:completed'
  | 'run:cancelled'
  | 'run:error';

export interface BuilderEvent {
  type: BuilderEventType;
  workflowId: string;
  runId?: string;
  payload?: unknown;
  ts: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(50);  // allow many open builder tabs simultaneously

export function emitBuilderEvent(event: Omit<BuilderEvent, 'ts'>): void {
  const full: BuilderEvent = { ...event, ts: new Date().toISOString() };
  bus.emit(event.workflowId, full);
  bus.emit('*', full);
}

export function onBuilderEvent(workflowId: string, listener: (e: BuilderEvent) => void): () => void {
  bus.on(workflowId, listener);
  return () => bus.off(workflowId, listener);
}

export function onAnyBuilderEvent(listener: (e: BuilderEvent) => void): () => void {
  bus.on('*', listener);
  return () => bus.off('*', listener);
}
