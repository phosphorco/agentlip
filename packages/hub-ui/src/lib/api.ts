/**
 * HTTP API client for hub endpoints
 */

import type { BootstrapConfig } from "./bootstrap";

export interface Channel {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface Topic {
  id: string;
  channel_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  topic_id: string;
  sender: string;
  content_raw: string;
  version: number;
  created_at: string;
  edited_at?: string;
  deleted_at?: string;
  deleted_by?: string;
}

export interface Attachment {
  id: string;
  message_id: string;
  topic_id: string;
  kind: string;
  value_json: Record<string, unknown>;
  created_at: string;
}

export interface Event {
  event_id: number;
  ts: string;
  name: string;
  scope: {
    channel_id?: string;
    topic_id?: string;
    topic_id2?: string;
  };
  entity: {
    type: string;
    id: string;
  } | null;
  data_json: Record<string, unknown>;
}

export class ApiClient {
  constructor(private config: BootstrapConfig) {}

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.config.authToken}`,
      ...init?.headers,
    };

    return fetch(url, { ...init, headers });
  }

  async getChannels(): Promise<Channel[]> {
    const res = await this.fetch("/api/v1/channels");
    if (!res.ok) throw new Error(`Failed to fetch channels: ${res.status}`);
    const data = await res.json();
    return data.channels || [];
  }

  async getTopics(channelId: string): Promise<Topic[]> {
    const res = await this.fetch(`/api/v1/channels/${encodeURIComponent(channelId)}/topics`);
    if (!res.ok) throw new Error(`Failed to fetch topics: ${res.status}`);
    const data = await res.json();
    return data.topics || [];
  }

  async getMessages(topicId: string, limit = 50): Promise<Message[]> {
    const res = await this.fetch(
      `/api/v1/messages?topic_id=${encodeURIComponent(topicId)}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
    const data = await res.json();
    return data.messages || [];
  }

  async getAttachments(topicId: string): Promise<Attachment[]> {
    const res = await this.fetch(`/api/v1/topics/${encodeURIComponent(topicId)}/attachments`);
    if (!res.ok) throw new Error(`Failed to fetch attachments: ${res.status}`);
    const data = await res.json();
    return data.attachments || [];
  }

  async getEvents(tail = 200): Promise<{ events: Event[]; replay_until: number }> {
    const res = await this.fetch(`/api/v1/events?tail=${tail}`);
    if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
    const data = await res.json();
    return {
      events: data.events || [],
      replay_until: data.replay_until || 0,
    };
  }

  async findChannel(channelId: string): Promise<Channel | null> {
    const channels = await this.getChannels();
    return channels.find((ch) => ch.id === channelId) || null;
  }

  async findTopic(topicId: string): Promise<{ topic: Topic; channel: Channel } | null> {
    const channels = await this.getChannels();
    for (const channel of channels) {
      const topics = await this.getTopics(channel.id);
      const topic = topics.find((t) => t.id === topicId);
      if (topic) {
        return { topic, channel };
      }
    }
    return null;
  }
}
