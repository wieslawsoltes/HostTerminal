import { PROTOCOL_VERSION, validateRequest, type BridgeStatus, type HostInfo, type HostEvent, type SessionInfo, type Request, type Result, type OutputEvent } from './protocol';
import { ReplayBuffer } from './replay';

export interface NativeTransport {
  request<T>(type: string, fields?: Record<string, unknown>): Promise<T>;
  send(message: Request): void;
  close(): void;
}
export interface ViewPort { postMessage(message: Result | HostEvent): void }
interface View { port: ViewPort }
interface Session { info?: SessionInfo; owner?: View; replay: ReplayBuffer; lastSeq: number; exitCode?: number }

/** Browser-independent routing layer. Only the extension service worker owns a native port. */
export class SessionBroker {
  private native?: NativeTransport;
  private connecting?: Promise<HostInfo>;
  private info?: HostInfo;
  private views = new Set<View>();
  private sessions = new Map<string, Session>();
  private retiredSessions = new Set<string>();
  private reconciliation?: { native: NativeTransport; again: boolean };
  constructor(private readonly open: (onEvent: (event: HostEvent) => void, onDisconnect: (message: string) => void) => NativeTransport) {}

  addView(port: ViewPort): View {
    const view = { port };
    this.views.add(view);
    return view;
  }

  removeView(view: View): void {
    this.views.delete(view);
    for (const [id, state] of this.sessions) {
      if (state.owner === view) {
        state.owner = undefined;
        this.ack(id, state.lastSeq);
      }
    }
  }

  private post(view: View, message: Result | HostEvent): void {
    if (!this.views.has(view)) return;
    try { view.port.postMessage(message); } catch { this.removeView(view); }
  }

  private ack(sessionId: string, seq: number): void {
    try { this.native?.send({ type: 'ack', sessionId, seq }); } catch { /* native disconnect handles cleanup */ }
  }

  private state(id: string): Session {
    let state = this.sessions.get(id);
    if (!state) {
      // Native host limits the total to 16; cap unsolicited event storage as well.
      if (this.sessions.size >= 32) throw new Error('Host exceeded the session limit');
      state = { replay: new ReplayBuffer(), lastSeq: 0 };
      this.sessions.set(id, state);
    }
    return state;
  }

  private forgetSession(id: string): void {
    this.sessions.delete(id);
    // Ignore recently closed sessions' late output/exit events without keeping
    // an unbounded set of every session this native host has ever created.
    this.retiredSessions.add(id);
    if (this.retiredSessions.size > 64) this.retiredSessions.delete(this.retiredSessions.values().next().value!);
  }

  private rememberSessions(list: SessionInfo[]): void {
    const ids = new Set(list.map(info => info.id));
    for (const key of this.sessions.keys()) if (!ids.has(key)) this.forgetSession(key);
    for (const info of list) {
      this.retiredSessions.delete(info.id);
      this.state(info.id).info = info;
    }
  }

  private reconcileSessions(): void {
    const native = this.native;
    if (!native) return;
    if (this.reconciliation?.native === native) { this.reconciliation.again = true; return; }
    const operation = { native, again: false };
    this.reconciliation = operation;
    void (async () => {
      try {
        do {
          operation.again = false;
          const list = await native.request<SessionInfo[]>('list');
          if (this.native !== native) return;
          this.rememberSessions(list);
        } while (operation.again);
      } catch { /* disconnect reporting owns errors; a subsequent change retries */ }
      finally { if (this.reconciliation === operation) this.reconciliation = undefined; }
    })();
  }

  private disconnected(message: string): void {
    this.native = undefined;
    this.info = undefined;
    this.connecting = undefined;
    this.sessions.clear();
    this.retiredSessions.clear();
    this.reconciliation = undefined;
    for (const view of this.views) this.post(view, { type: 'disconnected', message });
  }

  private event(event: HostEvent): void {
    if (event.type === 'disconnected') { this.disconnected(event.message); return; }
    if (event.type === 'sessionsChanged' || event.type === 'bridgeStatusChanged') {
      // MCP continues to work when every extension page is closed. The worker
      // must prune agent-closed sessions itself instead of relying on UI lists.
      if (event.type === 'sessionsChanged') this.reconcileSessions();
      for (const view of this.views) this.post(view, event);
      return;
    }
    if (this.retiredSessions.has(event.sessionId)) return;
    const state = this.state(event.sessionId);
    if (event.type === 'output') {
      if (event.seq <= state.lastSeq) return;
      state.lastSeq = event.seq;
      state.replay.append(event);
      if (state.owner) this.post(state.owner, event);
      else this.ack(event.sessionId, event.seq);
    } else {
      state.exitCode = event.exitCode;
      if (state.info) { state.info.exited = true; state.info.exitCode = event.exitCode; }
      if (state.owner) this.post(state.owner, event);
    }
  }

  private connect(): Promise<HostInfo> {
    if (this.info) return Promise.resolve(this.info);
    if (this.connecting) return this.connecting;
    const native = this.open(event => this.event(event), message => this.disconnected(message));
    this.native = native;
    const attempt = native.request<HostInfo>('hello').then(info => {
      if (info.protocol !== PROTOCOL_VERSION) throw new Error(`Protocol mismatch: extension ${PROTOCOL_VERSION}, host ${info.protocol}`);
      this.info = info;
      return info;
    }).catch(error => {
      if (this.native === native) {
        native.close();
        this.disconnected(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }).finally(() => { if (this.connecting === attempt) this.connecting = undefined; });
    this.connecting = attempt;
    return attempt;
  }

  async handle(view: View, raw: unknown): Promise<void> {
    let request: Request | undefined;
    const responseId = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined;
    try {
      if (!this.views.has(view)) return;
      request = validateRequest(raw);
      const { id, type, ...fields } = request;
      let value: unknown = null;
      let afterReply: (() => void) | undefined;
      if (type === 'connect' || type === 'hello') value = await this.connect();
      else {
        if (!this.native || !this.info) throw new Error('Connect to the companion first');
        const native = this.native;
        if (type === 'create') {
          const info = await native.request<SessionInfo>('create', fields);
          const state = this.state(info.id);
          state.info = info;
          if (state.exitCode !== undefined) { info.exited = true; info.exitCode = state.exitCode; }
          // A page closed while its shell started: leave it detached, available for reattachment.
          if (this.views.has(view)) {
            state.owner = view;
            const replay = state.replay.snapshot();
            afterReply = () => {
              for (const item of replay) this.post(view, { type: 'output', sessionId: info.id, ...item });
              if (state.exitCode !== undefined) this.post(view, { type: 'exit', sessionId: info.id, exitCode: state.exitCode });
            };
          }
          value = info;
        } else if (type === 'list') {
          const list = await native.request<SessionInfo[]>('list');
          if (this.native !== native) throw new Error('Native companion disconnected while listing sessions');
          this.rememberSessions(list);
          value = list;
        } else if (['bridgeEnable', 'bridgeDisable', 'bridgeStatus'].includes(type)) {
          const status = await native.request<BridgeStatus>(type);
          value = status;
          if (type !== 'bridgeStatus') afterReply = () => {
            for (const target of this.views) this.post(target, { type: 'bridgeStatusChanged', status });
          };
        } else if (type === 'shutdown') {
          await native.request('shutdown');
          native.close();
          this.disconnected('Companion stopped. All sessions were closed.');
        } else {
          const sessionId = fields.sessionId as string;
          const state = this.sessions.get(sessionId);
          if (!state?.info) throw new Error('Session no longer exists; refresh the session list');
          if (type === 'attach') {
            if (state.owner && state.owner !== view) throw new Error('This session is attached in another window. Detach it there first.');
            if (state.owner === view) throw new Error('This session is already attached');
            state.owner = view;
            value = { session: state.info, replay: state.replay.snapshot(), truncated: state.replay.truncated };
            if (state.exitCode !== undefined) afterReply = () => this.post(view, { type: 'exit', sessionId, exitCode: state.exitCode! });
          } else if (type === 'detach') {
            if (state.owner !== view) throw new Error('This window does not own the session');
            state.owner = undefined;
            this.ack(sessionId, state.lastSeq);
          } else if (type === 'ack') {
            if (state.owner !== view) throw new Error('This window does not own the session');
            if ((fields.seq as number) > state.lastSeq) throw new Error('Acknowledgement exceeds output sent');
            this.ack(sessionId, fields.seq as number);
          } else {
            if (['input', 'resize'].includes(type) && state.owner !== view) throw new Error('Attach the session in this window first');
            value = await native.request(type, fields);
            if (type === 'close') {
              if (state.owner) this.post(state.owner, { type: 'exit', sessionId, exitCode: state.exitCode ?? -1 });
              this.forgetSession(sessionId);
            }
            if (type === 'rename') state.info.title = fields.title as string;
            if (type === 'resize') { state.info.cols = fields.cols as number; state.info.rows = fields.rows as number; }
          }
        }
      }
      if (request.id) this.post(view, { type: 'result', id: request.id, ok: true, value });
      afterReply?.();
    } catch (error) {
      if (responseId) this.post(view, { type: 'result', id: responseId, ok: false, error: { code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
