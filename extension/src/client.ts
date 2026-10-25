import { UI_PORT_NAME, type HostEvent, type HostInfo, type Result } from './protocol';

export class HostClient {
  readonly extensionId = chrome.runtime.id;
  status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private port?: chrome.runtime.Port;
  private listeners = new Set<(event: HostEvent) => void>();
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private connecting?: Promise<HostInfo>;

  connect(): Promise<HostInfo> {
    if (this.connecting) return this.connecting;
    if (!this.port) {
      const port = chrome.runtime.connect({ name: UI_PORT_NAME });
      this.port = port;
      port.onMessage.addListener((message: Result | HostEvent) => {
        if (message.type === 'result') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.value);
          else pending.reject(new Error(message.error.message));
        } else {
          if (message.type === 'disconnected') this.status = 'disconnected';
          for (const listener of this.listeners) listener(message);
        }
      });
      port.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message ?? 'Extension connection closed. Reconnect to open new sessions.';
        if (this.port !== port) return;
        this.port = undefined;
        this.status = 'disconnected';
        this.rejectPending(message);
        for (const listener of this.listeners) listener({ type: 'disconnected', message });
      });
    }
    this.status = 'connecting';
    this.connecting = this.request<HostInfo>('connect').then(info => { this.status = 'connected'; return info; })
      .catch(error => { this.status = 'disconnected'; throw error; })
      .finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  request<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    const port = this.port;
    if (!port) return Promise.reject(new Error('Connect to the companion first'));
    if (this.pending.size >= 512) return Promise.reject(new Error('Too many pending terminal requests'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out (${type}). Check companion status before retrying.`));
      }, 20_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try { port.postMessage({ ...fields, id, type }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  onEvent(callback: (event: HostEvent) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  ack(sessionId: string, seq: number): void {
    try { this.port?.postMessage({ type: 'ack', sessionId, seq }); } catch { /* disconnect handler reports this */ }
  }

  disconnect(): void {
    const port = this.port;
    this.port = undefined;
    this.status = 'disconnected';
    port?.disconnect();
    this.rejectPending('This terminal window disconnected');
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
}
