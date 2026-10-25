import { SessionBroker, type NativeTransport } from './broker';
import { HOST_NAME, UI_PORT_NAME, isRecord, type HostEvent, type Request, type Result } from './protocol';

function openNative(onEvent: (event: HostEvent) => void, onDisconnect: (message: string) => void): NativeTransport {
  const port = chrome.runtime.connectNative(HOST_NAME);
  let alive = true;
  const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  function ended(message: string): void {
    if (!alive) return;
    alive = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
    onDisconnect(message);
  }
  port.onDisconnect.addListener(() => ended(chrome.runtime.lastError?.message ?? 'Native companion disconnected. Sessions ended.'));
  port.onMessage.addListener((raw: unknown) => {
    if (!alive || !isRecord(raw)) return;
    const message = raw as unknown as Result | HostEvent;
    if (message.type === 'result' && typeof message.id === 'string') {
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.ok) item.resolve(message.value);
      else item.reject(new Error(message.error.message));
    } else if ((message.type === 'output' || message.type === 'exit') && typeof message.sessionId === 'string') onEvent(message);
    else if (message.type === 'sessionsChanged') onEvent(message);
  });
  return {
    request<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
      if (!alive) return Promise.reject(new Error('Companion is disconnected'));
      if (pending.size >= 512) return Promise.reject(new Error('Too many pending native requests'));
      const id = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request timed out (${type})`)); }, 15_000);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        try { port.postMessage({ ...fields, id, type }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    send(message: Request): void { if (alive) port.postMessage(message); },
    close(): void { port.disconnect(); ended('Native companion stopped'); }
  };
}

const broker = new SessionBroker(openNative);
chrome.runtime.onConnect.addListener(port => {
  const expected = new URL(chrome.runtime.getURL('terminal.html'));
  let trusted = false;
  try {
    const sender = new URL(port.sender?.url ?? '');
    trusted = port.name === UI_PORT_NAME && port.sender?.id === chrome.runtime.id &&
      sender.protocol === expected.protocol && sender.host === expected.host && sender.pathname === expected.pathname;
  } catch { /* missing or invalid sender is not an extension UI */ }
  if (!trusted) { port.disconnect(); return; }
  const view = broker.addView(port);
  port.onMessage.addListener(message => { void broker.handle(view, message); });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; broker.removeView(view); });
});

async function openTerminal(): Promise<void> {
  const url = chrome.runtime.getURL('terminal.html');
  const existing = (await chrome.tabs.query({ url })).find(tab => tab.id !== undefined);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(() => { void openTerminal(); });
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-terminal') void openTerminal();
  if (command === 'open-side-panel' && tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
