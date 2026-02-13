/**
 * WebSocket client for live event streaming
 */

import type { BootstrapConfig } from "./bootstrap";
import type { Event } from "./api";

export interface WsHelloMessage {
  type: "hello";
  after_event_id: number;
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
}

export interface WsHelloOkMessage {
  type: "hello_ok";
  replay_until: number;
}

export interface WsEventMessage extends Event {
  type: "event";
}

type WsMessage = WsHelloOkMessage | WsEventMessage;

export type WsEventHandler = (event: Event) => void;
export type WsStatusHandler = (status: WsStatus) => void;

export enum WsStatus {
  Connecting = "connecting",
  Connected = "connected",
  Disconnected = "disconnected",
  Error = "error",
}

export class WsClient {
  private ws: WebSocket | null = null;
  private eventHandlers: Set<WsEventHandler> = new Set();
  private statusHandlers: Set<WsStatusHandler> = new Set();

  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  private afterEventId = 0;
  private subscriptions?: WsHelloMessage["subscriptions"];

  private seenEventIds = new Set<number>();
  private seenEventOrder: number[] = [];
  private maxSeenEventIds = 5000;

  private connectionGeneration = 0;
  private shouldReconnect = false;

  constructor(private config: BootstrapConfig) {}

  connect(afterEventId = 0, subscriptions?: WsHelloMessage["subscriptions"]): void {
    this.afterEventId = afterEventId;
    this.subscriptions = subscriptions;
    this.shouldReconnect = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.doConnect();
  }

  private doConnect(): void {
    const generation = ++this.connectionGeneration;

    if (this.ws) {
      const previous = this.ws;
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
      this.ws = null;
    }

    this.notifyStatus(WsStatus.Connecting);

    const ws = new WebSocket(`${this.config.wsUrl}?token=${encodeURIComponent(this.config.authToken)}`);
    this.ws = ws;

    ws.onopen = () => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;

      this.reconnectAttempts = 0;
      this.notifyStatus(WsStatus.Connected);

      const hello: WsHelloMessage = {
        type: "hello",
        after_event_id: this.afterEventId,
      };

      if (this.subscriptions) {
        hello.subscriptions = this.subscriptions;
      }

      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (msgEvent) => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;

      try {
        const msg: WsMessage = JSON.parse(msgEvent.data);

        if (msg.type === "hello_ok") {
          // Establish replay boundary even if no events are immediately delivered.
          this.afterEventId = Math.max(this.afterEventId, msg.replay_until);
          return;
        }

        if (msg.type === "event") {
          this.afterEventId = Math.max(this.afterEventId, msg.event_id);

          // Dedupe replay/live overlap by event_id.
          if (this.seenEventIds.has(msg.event_id)) {
            return;
          }

          this.seenEventIds.add(msg.event_id);
          this.seenEventOrder.push(msg.event_id);

          if (this.seenEventOrder.length > this.maxSeenEventIds) {
            const evicted = this.seenEventOrder.shift();
            if (evicted !== undefined) {
              this.seenEventIds.delete(evicted);
            }
          }

          this.notifyEvent(msg);
        }
      } catch (err) {
        console.error("WS message parse error:", err);
      }
    };

    ws.onerror = (err) => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;

      console.error("WebSocket error:", err);
      this.notifyStatus(WsStatus.Error);
    };

    ws.onclose = () => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;

      this.ws = null;
      this.notifyStatus(WsStatus.Disconnected);

      if (this.shouldReconnect) {
        this.attemptReconnect();
      }
    };
  }

  private attemptReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached");
      return;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  manualReconnect(): void {
    this.shouldReconnect = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts = 0;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectionGeneration++;

    if (this.ws) {
      const current = this.ws;
      this.ws = null;
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }

    this.notifyStatus(WsStatus.Disconnected);
  }

  onEvent(handler: WsEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: WsStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private notifyEvent(event: Event): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private notifyStatus(status: WsStatus): void {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}
