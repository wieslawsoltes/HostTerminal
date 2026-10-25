import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { HostClient } from './client';
import { base64ToBytes, bytesToBase64, type AttachResult, type BridgeStatus, type HostEvent, type HostInfo, type OutputEvent, type SessionInfo } from './protocol';
import { DEFAULTS, exportPreferences, importPreferences, loadPreferences, normalizePreferences, savePreferences, type Layout, type Preferences, type ShellProfile } from './settings';
import './terminal.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
};
const svgNS = 'http://www.w3.org/2000/svg';
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
function actionButton(label: string, iconName: string, action: () => void, className = 'icon-button small'): HTMLButtonElement {
  const button = element('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(iconName));
  button.addEventListener('click', event => { event.stopPropagation(); action(); });
  return button;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function basename(path: string): string { return path.split(/[\\/]/u).filter(Boolean).pop() || path; }
function safeTitle(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, 160); }
function shellProfile(): ShellProfile {
  const selectedId = $<HTMLSelectElement>('profile-select').value;
  return preferences.profiles.find(profile => profile.id === selectedId) || preferences.profiles[0]!;
}

interface TerminalView {
  session: SessionInfo;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  gpu?: WebglAddon;
  panel: HTMLElement;
  screen: HTMLElement;
  title: HTMLElement;
  metadata: HTMLElement;
  observer: ResizeObserver;
  lastSeq: number;
  attached: boolean;
  stale: boolean;
  closed: boolean;
  outputEnded: boolean;
  resizedCols: number;
  resizedRows: number;
  frame: number;
  input: Uint8Array[];
  inputBytes: number;
  inputTimer?: ReturnType<typeof setTimeout>;
  inputRunning: boolean;
  userTitle: boolean;
  searchCount: { index: number; total: number } | null;
}

const client = new HostClient();
const views = new Map<string, TerminalView>();
const sessions = new Map<string, SessionInfo>();
const pendingEvents = new Map<string, HostEvent[]>();
const attaching = new Set<string>();
let preferences: Preferences = structuredClone(DEFAULTS);
let host: HostInfo | null = null;
let activeId: string | null = null;
let visibleIds: string[] = [];
let layout: Layout = 'single';
let connection: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let connecting: Promise<void> | null = null;
let creating = false;
let toastTimer: ReturnType<typeof setTimeout>;
let renameId: string | null = null;
let profileDrafts: ShellProfile[] = [];
let editingProfile = '';
let bridge: BridgeStatus = { enabled: false };
let bridgeBusy = false;
let sessionRefresh: Promise<void> | null = null;
let sessionRefreshAgain = false;
let sessionRefreshFromAgent = false;

const themes: Record<Preferences['theme'], ITheme> = {
  midnight: { background: '#0a1018', foreground: '#d7e4f0', cursor: '#63dfc1', cursorAccent: '#0a1018', selectionBackground: '#355363', selectionInactiveBackground: '#253a46', black: '#263544', brightBlack: '#62788e', red: '#f28595', brightRed: '#ffa3af', green: '#7fdbad', brightGreen: '#a5e7bf', yellow: '#e7c484', brightYellow: '#f4d69f', blue: '#85b8f1', brightBlue: '#a3cdfa', magenta: '#c6a0ed', brightMagenta: '#d7b5fc', cyan: '#70d4d1', brightCyan: '#9ce5df', white: '#c6d4e2', brightWhite: '#edf5fc' },
  graphite: { background: '#161618', foreground: '#e5e2ec', cursor: '#c5b5fa', cursorAccent: '#161618', selectionBackground: '#494157', selectionInactiveBackground: '#35303d', black: '#343139', brightBlack: '#7e778e', red: '#ed899a', brightRed: '#f9aaba', green: '#a0cb8d', brightGreen: '#b8dda5', yellow: '#e6c07c', brightYellow: '#f1d5a4', blue: '#9fbbef', brightBlue: '#bfd2f6', magenta: '#c7a0e7', brightMagenta: '#dfb8f6', cyan: '#83ceca', brightCyan: '#a7e1dc', white: '#d8d2df', brightWhite: '#f8f6fb' },
  paper: { background: '#ffffff', foreground: '#203449', cursor: '#087c68', cursorAccent: '#ffffff', selectionBackground: '#bfd8e5', selectionInactiveBackground: '#e3eaf0', black: '#25394b', brightBlack: '#667b8d', red: '#b63348', brightRed: '#cd4055', green: '#237344', brightGreen: '#318b52', yellow: '#916215', brightYellow: '#a87614', blue: '#2867b6', brightBlue: '#397bcc', magenta: '#8954b1', brightMagenta: '#9c68c5', cyan: '#167d82', brightCyan: '#25949a', white: '#8496a6', brightWhite: '#4b6377' },
};

function toast(message: string, isError = false): void {
  const node = $('toast');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6500 : 3300);
}

function activeView(): TerminalView | undefined { return activeId ? views.get(activeId) : undefined; }
function focusTerminal(): void { activeView()?.terminal.focus(); }

function setConnection(next: typeof connection, description?: string): void {
  connection = next;
  const connected = next === 'connected';
  for (const id of ['host-indicator', 'footer-indicator']) {
    $(id).className = `status-dot ${next}`;
  }
  $('footer-status').textContent = connected ? 'Connected' : next === 'connecting' ? 'Connecting…' : 'Disconnected';
  $('host-description').textContent = connected && host ? `${host.os} · ${host.arch} · v${host.version}` : next === 'connecting' ? 'Starting native companion…' : 'Companion disconnected';
  $('host-name').textContent = connected && host ? `${host.os === 'macos' ? 'macOS' : host.os === 'windows' ? 'Windows' : 'Linux'} host` : 'This computer';
  $<HTMLButtonElement>('connect-button').disabled = next === 'connecting';
  $('connect-button').querySelector('span')!.textContent = next === 'connecting' ? 'Connecting…' : connected ? 'Start a new terminal' : 'Connect to this computer';
  const setupCard = document.querySelector<HTMLElement>('.setup-card');
  if (setupCard) setupCard.hidden = connected;
  $<HTMLButtonElement>('new-terminal').disabled = next === 'connecting' || creating;
  $<HTMLButtonElement>('sidebar-new').disabled = next === 'connecting' || creating;
  $<HTMLButtonElement>('disconnect-all').disabled = !connected;
  $<HTMLButtonElement>('reconnect-button').disabled = next === 'connecting';
  $('connection-banner').hidden = connected || views.size === 0;
  if (description) $('connection-message').textContent = description;
  else if (!connected) $('connection-message').textContent = 'Disconnected. Terminal transcripts remain visible.';
  if (!connected) bridge = { enabled: false };
  renderBridge();
  updateStatus();
}

function renderBridge(): void {
  const enabled = connection === 'connected' && bridge.enabled;
  $('agent-button').classList.toggle('agent-enabled', enabled);
  $('agent-button').title = `ChatGPT access: ${enabled ? 'enabled' : 'off'}`;
  $('agent-button').setAttribute('aria-label', `ChatGPT access: ${enabled ? 'enabled' : 'off'}`);
  $('agent-status').textContent = enabled ? 'ChatGPT access is enabled' : 'ChatGPT access is off';
  $('agent-status').classList.toggle('agent-active', enabled);
  $('agent-description').textContent = connection !== 'connected'
    ? 'Connect to the native companion first, then enable access for your ChatGPT plugin.'
    : enabled ? 'Your plugin can read and control the terminal sessions in this workspace. Access ends when you disable it or the native companion stops.'
      : 'Enable access to let your installed ChatGPT plugin create sessions, run commands, and read terminal output using your OS account.';
  $('agent-descriptor-row').hidden = !enabled || !bridge.descriptorPath;
  $('agent-descriptor').textContent = bridge.descriptorPath ?? '';
  $<HTMLButtonElement>('agent-enable').hidden = enabled;
  $<HTMLButtonElement>('agent-enable').disabled = connection !== 'connected' || bridgeBusy;
  $<HTMLButtonElement>('agent-disable').hidden = !enabled;
  $<HTMLButtonElement>('agent-disable').disabled = bridgeBusy;
}

async function openAgent(): Promise<void> {
  document.body.classList.remove('sidebar-open');
  $('agent-error').hidden = true;
  renderBridge();
  $<HTMLDialogElement>('agent-dialog').showModal();
  if (connection === 'connected') {
    try { bridge = await client.request<BridgeStatus>('bridgeStatus'); renderBridge(); }
    catch (error) { $('agent-error').textContent = `Install the matching native companion to use ChatGPT access. ${messageOf(error)}`; $('agent-error').hidden = false; }
  }
}

async function changeBridge(enabled: boolean): Promise<void> {
  if (bridgeBusy || connection !== 'connected') return;
  bridgeBusy = true;
  $('agent-error').hidden = true;
  renderBridge();
  try {
    bridge = await client.request<BridgeStatus>(enabled ? 'bridgeEnable' : 'bridgeDisable');
    toast(enabled ? 'ChatGPT access enabled for this native companion.' : 'ChatGPT access disabled. Your terminal sessions remain open.');
  } catch (error) { $('agent-error').textContent = messageOf(error); $('agent-error').hidden = false; }
  finally { bridgeBusy = false; renderBridge(); }
}

function updateStatus(): void {
  const view = activeView();
  $('active-shell').textContent = view ? basename(view.session.shell) : 'Native Messaging';
  $('terminal-dimensions').textContent = view ? `${view.terminal.cols} × ${view.terminal.rows}` : '';
  $('status-hint').textContent = view ? view.stale ? 'Offline transcript' : view.session.exited ? `Exited · ${view.session.exitCode ?? 0}` : view.session.pid ? `PID ${view.session.pid}` : 'Local session' : 'Ready when you are';
  for (const id of ['search-button', 'copy-button', 'export-button']) $<HTMLButtonElement>(id).disabled = !view;
  $<HTMLButtonElement>('paste-button').disabled = !view || !view.attached || view.session.exited || connection !== 'connected';
}

function renderSessions(): void {
  const list = $('session-list');
  const tabs = $('tabs');
  const listFragment = document.createDocumentFragment();
  const tabFragment = document.createDocumentFragment();
  const allIds = [...new Set([...sessions.keys(), ...views.keys()])];
  $('session-count').textContent = String(sessions.size);
  for (const id of allIds) {
    const view = views.get(id);
    const session = sessions.get(id) || view?.session;
    if (!session) continue;
    const title = safeTitle(session.title || basename(session.shell));
    const item = element('div', `session-item${id === activeId ? ' active' : ''}`);
    const button = element('button', 'session-main');
    button.type = 'button';
    button.title = `${title}\n${session.cwd}\n${session.shell}`;
    button.setAttribute('aria-label', `Open terminal ${title}`);
    button.append(icon('terminal'));
    const labels = element('span', 'session-info');
    labels.append(element('span', 'session-name', title));
    const state = view?.stale ? 'Offline transcript' : session.exited ? `Exited · ${session.exitCode ?? 0}` : view?.attached ? `${basename(session.shell)}${session.pid ? ` · ${session.pid}` : ''}` : 'Click to attach';
    labels.append(element('span', 'session-state', state));
    button.append(labels);
    button.addEventListener('click', () => {
      document.body.classList.remove('sidebar-open');
      if (view) activate(id);
      else void attachSession(id, true);
    });
    button.addEventListener('dblclick', () => openRename(id));
    item.append(button, actionButton(`Close ${title}`, 'close', () => { void closeSession(id); }, 'icon-button small close-session'));
    listFragment.append(item);
    if (view) {
      const tab = element('div', `terminal-tab${id === activeId ? ' active' : ''}`);
      const select = element('button', 'tab-select');
      select.id = `tab-${id}`;
      select.type = 'button';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(id === activeId));
      select.setAttribute('aria-controls', `pane-${id}`);
      select.tabIndex = id === activeId ? 0 : -1;
      select.title = title;
      select.append(icon('terminal'), element('span', '', title));
      select.addEventListener('click', () => activate(id));
      select.addEventListener('dblclick', () => openRename(id));
      select.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycleSession(event.key === 'ArrowLeft' ? -1 : 1); $(`tab-${activeId}`).focus(); }
      });
      tab.append(select, actionButton(`Close ${title}`, 'close', () => { void closeSession(id); }));
      tabFragment.append(tab);
      view.title.textContent = title;
      view.metadata.textContent = view.stale ? 'OFFLINE' : view.session.exited ? `EXIT ${view.session.exitCode ?? 0}` : view.session.pid ? `PID ${view.session.pid}` : '';
    }
  }
  if (!allIds.length) listFragment.append(element('p', 'empty-sessions', 'Connect to your computer to start a local terminal session.'));
  list.replaceChildren(listFragment);
  tabs.replaceChildren(tabFragment);
  updateStatus();
}

function maxPanes(): number { return layout === 'single' ? 1 : layout === 'grid' ? 4 : 2; }
function renderLayout(): void {
  const workspace = $('workspace');
  workspace.querySelectorAll('.empty-pane').forEach(node => node.remove());
  workspace.className = `workspace layout-${layout}`;
  visibleIds = visibleIds.filter(id => views.has(id)).slice(0, maxPanes());
  if (activeId && views.has(activeId) && !visibleIds.includes(activeId)) {
    if (visibleIds.length < maxPanes()) visibleIds.push(activeId);
    else visibleIds[visibleIds.length - 1] = activeId;
  }
  for (const id of views.keys()) if (visibleIds.length < maxPanes() && !visibleIds.includes(id)) visibleIds.push(id);
  for (const [id, view] of views) {
    view.panel.classList.toggle('pane-hidden', !visibleIds.includes(id));
    view.panel.classList.toggle('active', id === activeId);
    view.panel.style.order = String(visibleIds.indexOf(id));
    if (visibleIds.includes(id)) queueFit(view);
  }
  if (views.size) {
    for (let slot = visibleIds.length; slot < maxPanes(); slot++) {
      const empty = element('div', 'empty-pane');
      empty.style.order = String(slot);
      const add = element('button', 'empty-pane-action');
      add.type = 'button';
      add.append(icon('plus'), element('span', '', 'New terminal'), element('small', '', 'Use the selected shell profile'));
      add.addEventListener('click', () => { void createSession(shellProfile()); });
      empty.append(add);
      workspace.append(empty);
    }
  }
  $('welcome').hidden = views.size > 0;
  if (!views.size) {
    workspace.className = 'workspace layout-single';
    $('connection-banner').hidden = true;
  }
  updateStatus();
}

function activate(id: string, focus = true): void {
  if (!views.has(id)) return;
  activeId = id;
  renderLayout();
  renderSessions();
  if (focus) requestAnimationFrame(() => views.get(id)?.terminal.focus());
  if (!$('search-bar').hidden) runSearch('next', true);
}

function cycleSession(direction: number): void {
  const ids = [...views.keys()];
  if (!ids.length) return;
  const index = activeId ? ids.indexOf(activeId) : 0;
  activate(ids[(index + direction + ids.length) % ids.length]!);
}

function changeLayout(value: Layout): void {
  layout = value;
  $<HTMLSelectElement>('layout-select').value = value;
  if (value === 'single' && activeId) visibleIds = [activeId];
  renderLayout();
  focusTerminal();
}

function queueFit(view: TerminalView): void {
  if (view.closed) return;
  cancelAnimationFrame(view.frame);
  view.frame = requestAnimationFrame(() => {
    if (view.closed || view.panel.classList.contains('pane-hidden') || view.screen.clientWidth < 30 || view.screen.clientHeight < 20) return;
    const dimensions = view.fit.proposeDimensions();
    if (!dimensions || dimensions.cols < 2 || dimensions.rows < 2) return;
    const cols = Math.max(2, Math.min(1000, dimensions.cols));
    const rows = Math.max(2, Math.min(1000, dimensions.rows));
    if (view.terminal.cols !== cols || view.terminal.rows !== rows) view.terminal.resize(cols, rows);
    if (view.attached && !view.session.exited && connection === 'connected' && (cols !== view.resizedCols || rows !== view.resizedRows)) {
      view.resizedCols = cols;
      view.resizedRows = rows;
      void client.request('resize', { sessionId: view.session.id, cols, rows }).catch(error => {
        if (!view.closed && view.attached && !view.session.exited) toast(`Resize failed: ${messageOf(error)}`, true);
      });
    }
    if (activeId === view.session.id) updateStatus();
  });
}

function configureGpu(view: TerminalView): void {
  if (!preferences.gpuAcceleration) { view.gpu?.dispose(); view.gpu = undefined; return; }
  if (view.gpu) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => { addon.dispose(); if (view.gpu === addon) view.gpu = undefined; });
    view.terminal.loadAddon(addon);
    view.gpu = addon;
  } catch {
    view.gpu = undefined;
  }
}

function safeLink(event: MouseEvent, uri: string): void {
  // Opening is an explicit gesture. Terminal-controlled text can never execute a URI.
  event.preventDefault();
  if (!event.isTrusted) return;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') { toast('Only HTTP and HTTPS links can be opened.'); return; }
    window.open(url.href, '_blank', 'noopener,noreferrer');
  } catch { toast('This terminal link is not a valid web URL.', true); }
}

function createView(session: SessionInfo): TerminalView {
  const existing = views.get(session.id);
  if (existing) { existing.session = session; existing.attached = true; existing.stale = false; return existing; }
  const terminal = new Terminal({
    cols: session.cols, rows: session.rows,
    // The pinned official search addon uses xterm's decoration API for match highlights.
    allowProposedApi: true,
    allowTransparency: false,
    fontFamily: preferences.fontFamily,
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    scrollback: preferences.scrollback,
    cursorStyle: preferences.cursorStyle,
    cursorBlink: preferences.cursorBlink,
    theme: themes[preferences.theme],
    convertEol: false,
    screenReaderMode: preferences.screenReaderMode,
    windowsPty: host?.os === 'windows' ? { backend: 'conpty' } : undefined,
    linkHandler: { activate: safeLink },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(serialize);
  terminal.loadAddon(new WebLinksAddon(safeLink));
  const panel = element('section', 'terminal-pane pane-hidden');
  panel.id = `pane-${session.id}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${session.id}`);
  const heading = element('div', 'pane-heading');
  const titleLabel = element('div', 'pane-title');
  const title = element('span', '', safeTitle(session.title));
  titleLabel.append(icon('terminal'), title);
  const metadata = element('span', 'pane-metadata');
  heading.append(titleLabel, metadata,
    actionButton('Rename terminal', 'edit', () => openRename(session.id)),
    actionButton('Close terminal', 'close', () => { void closeSession(session.id); }));
  const screen = element('div', 'terminal-screen');
  panel.append(heading, screen);
  $('workspace').append(panel);
  terminal.open(screen);
  const view: TerminalView = {
    session, terminal, fit, search, serialize, panel, screen, title, metadata,
    observer: new ResizeObserver(() => queueFit(view)), lastSeq: 0, attached: true, stale: false, closed: false, outputEnded: false,
    resizedCols: session.cols, resizedRows: session.rows, frame: 0, input: [], inputBytes: 0, inputRunning: false, userTitle: false, searchCount: null,
  };
  views.set(session.id, view);
  panel.addEventListener('pointerdown', () => { if (activeId !== session.id) activate(session.id, false); });
  panel.addEventListener('focusin', () => { if (activeId !== session.id) activate(session.id, false); });
  // Capture paste before xterm's handler so multiline input can be reviewed once.
  screen.addEventListener('paste', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = event.clipboardData?.getData('text/plain');
    if (text !== undefined) void pasteText(view, text);
  }, { capture: true });
  screen.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
  screen.addEventListener('drop', event => { event.preventDefault(); toast('For local files, type or paste their full path. Chrome does not expose dropped file paths.'); });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    if (handleShortcut(event)) return false;
    // Cmd+C uses standard selection semantics; Ctrl+C remains a terminal interrupt.
    if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
      event.preventDefault(); void copySelection(view); return false;
    }
    if (view.session.exited || view.stale) return false;
    return true;
  });
  terminal.onData(data => queueInput(view, new TextEncoder().encode(data)));
  terminal.onBinary(data => queueInput(view, Uint8Array.from(data, c => c.charCodeAt(0) & 0xff)));
  terminal.onTitleChange(titleText => {
    // Terminal title is untrusted display text; never invoke commands or write HTML.
    if (!view.userTitle && titleText.trim()) {
      view.title.textContent = safeTitle(titleText);
      panel.title = safeTitle(titleText);
    }
  });
  // OSC 52 is intentionally handled and ignored: terminal output cannot read or set the clipboard.
  terminal.parser.registerOscHandler(52, () => true);
  search.onDidChangeResults(results => {
    view.searchCount = { index: results.resultIndex, total: results.resultCount };
    if (activeId === session.id) updateSearchResult(view);
  });
  view.observer.observe(screen);
  configureGpu(view);
  return view;
}

function consumeOutput(view: TerminalView, event: Pick<OutputEvent, 'data' | 'seq'>): void {
  if (view.closed) return;
  // A duplicated replay chunk may already be queued in xterm but not yet parsed.
  // Only the original write callback may release its host credit.
  if (event.seq <= view.lastSeq) return;
  const bytes = base64ToBytes(event.data);
  view.lastSeq = event.seq;
  view.terminal.write(bytes, () => {
    if (!view.closed && view.attached && connection === 'connected') client.ack(view.session.id, event.seq);
  });
}

function handleEvent(event: HostEvent): void {
  if (event.type === 'bridgeStatusChanged') { bridge = event.status; renderBridge(); return; }
  if (event.type === 'sessionsChanged') { void refreshSessions(true); return; }
  if (event.type === 'disconnected') {
    host = null;
    pendingEvents.clear();
    for (const view of views.values()) {
      view.attached = false;
      view.stale = true;
      view.input = [];
      view.inputBytes = 0;
      clearTimeout(view.inputTimer);
    }
    setConnection('disconnected', event.message || 'The native companion disconnected.');
    renderSessions();
    return;
  }
  const view = views.get(event.sessionId);
  if (!view || attaching.has(event.sessionId)) {
    // Ignore late close events rather than retaining transcripts for disposed panes.
    if (!view && !creating && !attaching.has(event.sessionId)) return;
    // New-session output may precede the create reply. The host's credit window bounds it.
    let queue = pendingEvents.get(event.sessionId);
    if (!queue) { queue = []; pendingEvents.set(event.sessionId, queue); }
    queue.push(event);
    return;
  }
  if (event.type === 'output') consumeOutput(view, event);
  else if (event.type === 'exit') markExited(view, event.exitCode);
}

function markExited(view: TerminalView, exitCode: number): void {
  if (view.outputEnded) return;
  view.outputEnded = true;
  view.terminal.options.disableStdin = true;
  view.session.exited = true;
  view.session.exitCode = exitCode;
  view.input = [];
  view.inputBytes = 0;
  clearTimeout(view.inputTimer);
  const session = sessions.get(view.session.id);
  if (session) { session.exited = true; session.exitCode = exitCode; }
  // Native host guarantees this event follows all PTY output. xterm queues this text last.
  view.terminal.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
  renderSessions();
}

function flushPending(view: TerminalView): void {
  const events = pendingEvents.get(view.session.id) || [];
  pendingEvents.delete(view.session.id);
  for (const event of events) if (event.type === 'output') consumeOutput(view, event); else if (event.type === 'exit') markExited(view, event.exitCode);
}

function queueInput(view: TerminalView, bytes: Uint8Array): void {
  // Process metadata can be exited before ConPTY has finished producing output.
  // Device replies generated by xterm must still reach the PTY until actual EOF.
  if (!bytes.length || view.closed || !view.attached || view.outputEnded || connection !== 'connected') return;
  if (view.inputBytes + bytes.byteLength > 2 * 1024 * 1024) { toast('Input queue is full. Wait for the shell before pasting more.', true); return; }
  view.input.push(bytes);
  view.inputBytes += bytes.byteLength;
  if (!view.inputTimer && !view.inputRunning) view.inputTimer = setTimeout(() => { view.inputTimer = undefined; void flushInput(view); }, 4);
}

async function flushInput(view: TerminalView): Promise<void> {
  if (view.inputRunning) return;
  view.inputRunning = true;
  try {
    while (view.inputBytes > 0 && view.attached && !view.closed && !view.outputEnded && connection === 'connected') {
      const length = Math.min(view.inputBytes, Math.min(host?.limits.maxInputBytes ?? 65536, 32768));
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const chunk = view.input[0]!;
        const take = Math.min(chunk.length, length - offset);
        bytes.set(chunk.subarray(0, take), offset);
        offset += take;
        if (take === chunk.length) view.input.shift();
        else view.input[0] = chunk.subarray(take);
      }
      view.inputBytes -= length;
      await client.request('input', { sessionId: view.session.id, data: bytesToBase64(bytes) });
    }
  } catch (error) {
    view.input = [];
    view.inputBytes = 0;
    if (!view.closed && connection === 'connected') toast(`Input failed: ${messageOf(error)}`, true);
  } finally { view.inputRunning = false; }
}

async function attachSession(id: string, focus = false): Promise<boolean> {
  if (connection !== 'connected' || attaching.has(id)) return false;
  attaching.add(id);
  try {
    const attached = await client.request<AttachResult>('attach', { sessionId: id });
    sessions.set(id, attached.session);
    const view = createView(attached.session);
    if (attached.truncated && (!view.lastSeq || (attached.replay[0] && attached.replay[0].seq - base64ToBytes(attached.replay[0].data).length > view.lastSeq))) {
      view.terminal.writeln('\x1b[90m[Reattached: only recent output is available; screen state may be incomplete.]\x1b[0m');
    }
    for (const chunk of attached.replay) consumeOutput(view, chunk);
    attaching.delete(id);
    flushPending(view);
    if (!activeId || focus) activate(id, focus);
    else { renderLayout(); renderSessions(); }
    return true;
  } catch (error) {
    toast(`Could not attach: ${messageOf(error)}`, true);
    return false;
  } finally { attaching.delete(id); }
}

async function connectHost(autoCreate = true): Promise<void> {
  if (connection === 'connected') return;
  if (connecting) return connecting;
  connecting = (async () => {
    setConnection('connecting');
    $('connect-error').hidden = true;
    try {
      host = await client.connect();
      if (host.protocol !== 1) throw new Error(`Companion protocol ${host.protocol} is incompatible. Install the matching companion.`);
      setConnection('connected');
      renderShellOptions();
      try { bridge = await client.request<BridgeStatus>('bridgeStatus'); renderBridge(); }
      catch { /* Older companions still support the terminal; the access dialog explains upgrading. */ }
      const current = await client.request<SessionInfo[]>('list');
      sessions.clear();
      for (const session of current) sessions.set(session.id, session);
      for (const [id, view] of views) if (!sessions.has(id)) { view.stale = true; view.attached = false; }
      let attached = 0;
      for (const session of current) if (await attachSession(session.id, attached === 0)) attached++;
      renderSessions();
      if (autoCreate && current.length === 0) await createSession(shellProfile());
      else if (current.length > 0 && !attached) toast('Sessions may be open in another tab. Select a session to attach after detaching its other view.');
    } catch (error) {
      client.disconnect();
      host = null;
      const message = messageOf(error);
      setConnection('disconnected', message);
      $('connect-error').textContent = message;
      $('connect-error').hidden = false;
      if (views.size) toast(message, true);
    }
  })();
  try { await connecting; } finally { connecting = null; }
}

async function createSession(profile: ShellProfile): Promise<void> {
  if (creating) return;
  if (connection !== 'connected') { await connectHost(false); if (connection as string !== 'connected') return; }
  if (sessions.size >= (host?.limits.maxSessions ?? 16)) { toast('Session limit reached. Close an existing session first.', true); return; }
  creating = true;
  setConnection(connection);
  try {
    const active = activeView();
    const fields: Record<string, unknown> = {
      cols: Math.max(2, active?.terminal.cols ?? 100), rows: Math.max(2, active?.terminal.rows ?? 30),
      title: profile.name === 'Default shell' ? basename(host?.defaultShell || 'Terminal') : profile.name,
    };
    if (profile.shell.trim()) fields.shell = profile.shell.trim();
    if (profile.args.length || profile.shell.trim()) fields.args = profile.args;
    if (profile.cwd.trim()) fields.cwd = profile.cwd.trim();
    if (Object.keys(profile.env).length) fields.env = profile.env;
    const session = await client.request<SessionInfo>('create', fields);
    sessions.set(session.id, session);
    const view = createView(session);
    flushPending(view);
    activate(session.id);
  } catch (error) { toast(`Could not start terminal: ${messageOf(error)}`, true); }
  finally { creating = false; setConnection(connection); }
}

function confirmAction(title: string, message: string, accept = 'Continue', preview?: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-accept').textContent = accept;
  $('confirm-preview').hidden = preview === undefined;
  $('confirm-preview').textContent = preview || '';
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true });
    dialog.showModal();
  });
}

function disposeView(view: TerminalView): void {
  view.closed = true;
  view.attached = false;
  view.observer.disconnect();
  clearTimeout(view.inputTimer);
  cancelAnimationFrame(view.frame);
  view.terminal.dispose();
  view.panel.remove();
  views.delete(view.session.id);
  pendingEvents.delete(view.session.id);
  visibleIds = visibleIds.filter(id => id !== view.session.id);
  if (activeId === view.session.id) activeId = visibleIds[0] || views.keys().next().value || null;
  renderLayout();
  renderSessions();
}

async function closeSession(id: string): Promise<void> {
  const view = views.get(id);
  const session = sessions.get(id) || view?.session;
  if (!session) return;
  if (!session.exited && !view?.stale && connection === 'connected') {
    if (!await confirmAction('Close terminal?', `The shell and its attached job in “${safeTitle(session.title)}” will be terminated.`, 'Close terminal')) return;
  }
  try {
    if (connection === 'connected' && !view?.stale) await client.request('close', { sessionId: id });
    sessions.delete(id);
    if (view) disposeView(view);
    else renderSessions();
    focusTerminal();
  } catch (error) { toast(`Could not close terminal: ${messageOf(error)}`, true); }
}

async function detachSession(): Promise<void> {
  const view = activeView();
  if (!view) return;
  try {
    if (view.attached && connection === 'connected') await client.request('detach', { sessionId: view.session.id });
    disposeView(view);
    toast('View detached. The shell continues in the native companion.');
  } catch (error) { toast(messageOf(error), true); }
}

async function shutdown(): Promise<void> {
  if (connection !== 'connected') return;
  if (!await confirmAction('End all terminal sessions?', 'This stops every shell owned by the companion, including sessions attached to another extension page.', 'End all sessions')) return;
  try { await client.request('shutdown'); }
  catch (error) { if ((connection as string) !== 'disconnected') toast(messageOf(error), true); }
  sessions.clear();
  for (const view of views.values()) { view.attached = false; view.stale = true; }
  client.disconnect();
  setConnection('disconnected', 'All companion sessions ended. Connect to start again.');
  renderSessions();
}

function openRename(id: string): void {
  const session = sessions.get(id) || views.get(id)?.session;
  if (!session) return;
  renameId = id;
  $<HTMLInputElement>('rename-input').value = session.title;
  $<HTMLDialogElement>('rename-dialog').showModal();
  $<HTMLInputElement>('rename-input').select();
}

async function renameSession(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!renameId) return;
  const title = safeTitle($<HTMLInputElement>('rename-input').value.trim()).slice(0, 100);
  if (!title) return;
  const view = views.get(renameId);
  try {
    if (connection === 'connected' && !view?.stale) await client.request('rename', { sessionId: renameId, title });
    const session = sessions.get(renameId);
    if (session) session.title = title;
    if (view) { view.session.title = title; view.userTitle = true; }
    $<HTMLDialogElement>('rename-dialog').close();
    renderSessions();
    focusTerminal();
  } catch (error) { toast(messageOf(error), true); }
}

async function copyText(text: string, message = 'Copied to clipboard.'): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast('Clipboard access was denied. Use the browser’s copy shortcut or context menu.', true); }
}

async function copySelection(view = activeView()): Promise<void> {
  if (!view) return;
  const selection = view.terminal.getSelection();
  if (!selection) { toast('Select terminal text to copy.'); return; }
  await copyText(selection);
}

async function pasteText(view: TerminalView, text: string): Promise<void> {
  if (!view.attached || view.closed || view.session.exited || connection !== 'connected') { toast('Connect to a running terminal before pasting.'); return; }
  if (!text) return;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 1024 * 1024) { toast('Paste is limited to 1 MiB at a time.', true); return; }
  if (preferences.confirmMultilinePaste && /[\r\n\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) {
    const preview = text.replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/gu, c => `⟨0x${c.charCodeAt(0).toString(16).padStart(2, '0')}⟩`).slice(0, 8000);
    const lines = text.split(/\r\n|\r|\n/u).length;
    if (!await confirmAction('Review terminal paste', `${lines} line${lines === 1 ? '' : 's'}, ${bytes.length.toLocaleString()} bytes. Newlines and control characters can execute commands.${text.length > 8000 ? ' Preview is truncated.' : ''}`, 'Paste into terminal', preview)) return;
  }
  if (view.closed || !view.attached || view.session.exited || connection !== 'connected') return;
  view.terminal.paste(text);
  view.terminal.focus();
}

async function pasteClipboard(): Promise<void> {
  const view = activeView();
  if (!view) return;
  try { await pasteText(view, await navigator.clipboard.readText()); }
  catch { toast('Clipboard access was denied. Focus the terminal and use Ctrl+Shift+V or ⌘V.', true); }
}

function downloadFile(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = element('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportTranscript(ansi = false): void {
  const view = activeView();
  if (!view) return;
  let content: string;
  if (ansi) content = view.serialize.serialize({ scrollback: preferences.scrollback });
  else {
    const lines: string[] = [];
    const buffer = view.terminal.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    content = lines.join('\n').replace(/\n+$/u, '') + '\n';
  }
  const name = safeTitle(view.session.title).replace(/[^a-zA-Z0-9_.-]+/gu, '-').replace(/^-|-$/gu, '') || 'terminal';
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  downloadFile(`${name}-${timestamp}.${ansi ? 'ansi' : 'txt'}`, content, 'text/plain;charset=utf-8');
  toast('Exported the current terminal buffer and scrollback.');
}

function openSearch(): void {
  if (!activeView()) return;
  $('search-bar').hidden = false;
  const input = $<HTMLInputElement>('search-input');
  if (activeView()?.terminal.hasSelection()) input.value = activeView()!.terminal.getSelection().split('\n')[0]!.slice(0, 500);
  input.focus();
  input.select();
  if (input.value) runSearch('next', true);
}
function closeSearch(): void {
  $('search-bar').hidden = true;
  activeView()?.search.clearDecorations();
  focusTerminal();
}
function updateSearchResult(view: TerminalView): void {
  const result = view.searchCount;
  $('search-results').textContent = result ? result.total ? `${result.index + 1} / ${result.total}` : 'No matches' : '';
}
function runSearch(direction: 'next' | 'prev', incremental = false): void {
  const view = activeView();
  if (!view) return;
  const query = $<HTMLInputElement>('search-input').value;
  if (!query) { view.search.clearDecorations(); $('search-results').textContent = ''; return; }
  try {
    if ($<HTMLInputElement>('search-regex').checked) new RegExp(query);
    const options = {
      caseSensitive: $<HTMLInputElement>('search-case').checked,
      regex: $<HTMLInputElement>('search-regex').checked,
      incremental,
      decorations: {
        matchBackground: '#796230', matchBorder: '#967b44', matchOverviewRuler: '#967b44',
        activeMatchBackground: '#126c5b', activeMatchBorder: '#63dfc1', activeMatchColorOverviewRuler: '#63dfc1',
      },
    };
    const found = direction === 'prev' ? view.search.findPrevious(query, options) : view.search.findNext(query, options);
    if (!found) $('search-results').textContent = 'No matches';
    else updateSearchResult(view);
  } catch { $('search-results').textContent = 'Invalid expression'; }
}

function renderProfileOptions(): void {
  const launch = $<HTMLSelectElement>('profile-select');
  const previous = launch.value;
  for (const select of [launch, $<HTMLSelectElement>('setting-default-profile')]) {
    select.replaceChildren();
    for (const profile of preferences.profiles) {
      const option = element('option', '', profile.name);
      option.value = profile.id;
      select.append(option);
    }
  }
  launch.value = preferences.profiles.some(profile => profile.id === previous) ? previous : preferences.defaultProfileId;
  $<HTMLSelectElement>('setting-default-profile').value = preferences.defaultProfileId;
}

function renderShellOptions(): void {
  const list = $('shell-options');
  list.replaceChildren();
  for (const shell of host?.shells || []) {
    const option = element('option');
    option.value = shell.path;
    option.label = shell.name;
    list.append(option);
  }
}

function applyPreferences(): void {
  document.documentElement.dataset.theme = preferences.theme;
  for (const view of views.values()) {
    view.terminal.options.theme = themes[preferences.theme];
    view.terminal.options.fontFamily = preferences.fontFamily;
    view.terminal.options.fontSize = preferences.fontSize;
    view.terminal.options.lineHeight = preferences.lineHeight;
    view.terminal.options.scrollback = preferences.scrollback;
    view.terminal.options.cursorStyle = preferences.cursorStyle;
    view.terminal.options.cursorBlink = preferences.cursorBlink;
    view.terminal.options.screenReaderMode = preferences.screenReaderMode;
    configureGpu(view);
    queueFit(view);
  }
  renderProfileOptions();
}

function openSettings(): void {
  $<HTMLSelectElement>('setting-theme').value = preferences.theme;
  $<HTMLInputElement>('setting-font-size').value = String(preferences.fontSize);
  $<HTMLInputElement>('setting-font-family').value = preferences.fontFamily;
  $<HTMLInputElement>('setting-line-height').value = String(preferences.lineHeight);
  $<HTMLSelectElement>('setting-cursor').value = preferences.cursorStyle;
  $<HTMLInputElement>('setting-blink').checked = preferences.cursorBlink;
  $<HTMLInputElement>('setting-gpu').checked = preferences.gpuAcceleration;
  $<HTMLInputElement>('setting-screen-reader').checked = preferences.screenReaderMode;
  $<HTMLInputElement>('setting-scrollback').value = String(preferences.scrollback);
  $<HTMLInputElement>('setting-paste').checked = preferences.confirmMultilinePaste;
  $<HTMLSelectElement>('setting-default-profile').value = preferences.defaultProfileId;
  if (!$<HTMLDialogElement>('settings-dialog').open) $<HTMLDialogElement>('settings-dialog').showModal();
}

async function submitSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const next = normalizePreferences({
    ...preferences,
    theme: $<HTMLSelectElement>('setting-theme').value,
    fontSize: Number($<HTMLInputElement>('setting-font-size').value),
    fontFamily: $<HTMLInputElement>('setting-font-family').value,
    lineHeight: Number($<HTMLInputElement>('setting-line-height').value),
    cursorStyle: $<HTMLSelectElement>('setting-cursor').value,
    cursorBlink: $<HTMLInputElement>('setting-blink').checked,
    gpuAcceleration: $<HTMLInputElement>('setting-gpu').checked,
    screenReaderMode: $<HTMLInputElement>('setting-screen-reader').checked,
    scrollback: Number($<HTMLInputElement>('setting-scrollback').value),
    confirmMultilinePaste: $<HTMLInputElement>('setting-paste').checked,
    defaultProfileId: $<HTMLSelectElement>('setting-default-profile').value,
  });
  try {
    await savePreferences(next);
    preferences = next;
    applyPreferences();
    $<HTMLDialogElement>('settings-dialog').close();
    toast('Terminal settings saved.');
    focusTerminal();
  } catch (error) { toast(`Could not save settings: ${messageOf(error)}`, true); }
}

function renderProfileEditor(): void {
  const select = $<HTMLSelectElement>('edit-profile-select');
  select.replaceChildren();
  for (const profile of profileDrafts) {
    const option = element('option', '', profile.name);
    option.value = profile.id;
    select.append(option);
  }
  const profile = profileDrafts.find(item => item.id === editingProfile) || profileDrafts[0]!;
  editingProfile = profile.id;
  select.value = profile.id;
  $<HTMLInputElement>('profile-name').value = profile.name;
  $<HTMLInputElement>('profile-shell').value = profile.shell;
  $<HTMLTextAreaElement>('profile-args').value = JSON.stringify(profile.args, null, 2);
  $<HTMLInputElement>('profile-cwd').value = profile.cwd;
  $<HTMLTextAreaElement>('profile-env').value = JSON.stringify(profile.env, null, 2);
  $<HTMLButtonElement>('delete-profile').disabled = profileDrafts.length <= 1;
  $('profile-error').hidden = true;
}

function openProfiles(): void {
  profileDrafts = structuredClone(preferences.profiles);
  editingProfile = $<HTMLSelectElement>('profile-select').value;
  renderProfileEditor();
  renderShellOptions();
  $<HTMLDialogElement>('profiles-dialog').showModal();
}

function readProfileDraft(): ShellProfile {
  const name = $<HTMLInputElement>('profile-name').value.trim();
  const shell = $<HTMLInputElement>('profile-shell').value.trim();
  const cwd = $<HTMLInputElement>('profile-cwd').value.trim();
  if (!name) throw new Error('Enter a profile name.');
  if (shell.includes('\0') || cwd.includes('\0')) throw new Error('Paths cannot contain NUL characters.');
  const args: unknown = JSON.parse($<HTMLTextAreaElement>('profile-args').value);
  if (!Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)) throw new Error('Arguments must be a JSON array of at most 128 strings.');
  const env: unknown = JSON.parse($<HTMLTextAreaElement>('profile-env').value);
  if (env === null || Array.isArray(env) || typeof env !== 'object' || Object.keys(env).length > 128 || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768)) throw new Error('Environment must be a JSON object with valid variable names and string values.');
  return { id: editingProfile, name, shell, args: args as string[], cwd, env: env as Record<string, string> };
}

function captureProfileDraft(): boolean {
  try {
    const profile = readProfileDraft();
    const index = profileDrafts.findIndex(item => item.id === editingProfile);
    if (index >= 0) profileDrafts[index] = profile;
    $('profile-error').hidden = true;
    return true;
  } catch (error) { $('profile-error').textContent = messageOf(error); $('profile-error').hidden = false; return false; }
}

async function saveProfiles(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!captureProfileDraft()) return;
  try {
    const next = normalizePreferences({ ...preferences, profiles: profileDrafts });
    await savePreferences(next);
    preferences = next;
    renderProfileOptions();
    $<HTMLSelectElement>('profile-select').value = editingProfile;
    $<HTMLDialogElement>('profiles-dialog').close();
    toast('Shell profiles saved. Existing sessions keep their current shell.');
  } catch (error) { $('profile-error').textContent = messageOf(error); $('profile-error').hidden = false; }
}

interface PaletteCommand { name: string; icon: string; shortcut?: string; run: () => void; enabled?: () => boolean }
const commands: PaletteCommand[] = [
  { name: 'New terminal', icon: 'plus', shortcut: '⇧ Enter', run: () => { void createSession(shellProfile()); } },
  { name: 'Connect to native companion', icon: 'terminal', run: () => { void connectHost(); }, enabled: () => connection !== 'connected' },
  { name: 'Find in terminal', icon: 'search', shortcut: '⇧ F', run: openSearch, enabled: () => !!activeView() },
  { name: 'Rename active terminal', icon: 'edit', run: () => { if (activeId) openRename(activeId); }, enabled: () => !!activeView() },
  { name: 'Copy selection', icon: 'copy', shortcut: '⇧ C', run: () => { void copySelection(); }, enabled: () => !!activeView() },
  { name: 'Paste clipboard', icon: 'paste', run: () => { void pasteClipboard(); }, enabled: () => !!activeView()?.attached },
  { name: 'Clear terminal scrollback', icon: 'terminal', run: () => { activeView()?.terminal.clear(); focusTerminal(); }, enabled: () => !!activeView() },
  { name: 'Export scrollback as text', icon: 'download', run: () => exportTranscript(), enabled: () => !!activeView() },
  { name: 'Export buffer as ANSI', icon: 'download', run: () => exportTranscript(true), enabled: () => !!activeView() },
  { name: 'Layout: single terminal', icon: 'terminal', run: () => changeLayout('single') },
  { name: 'Layout: side by side', icon: 'split', run: () => changeLayout('columns') },
  { name: 'Layout: stacked', icon: 'split', run: () => changeLayout('rows') },
  { name: 'Layout: four-pane grid', icon: 'split', run: () => changeLayout('grid') },
  { name: 'Next session', icon: 'arrow', shortcut: 'Alt ]', run: () => cycleSession(1), enabled: () => views.size > 1 },
  { name: 'Detach active view (keep shell running)', icon: 'terminal', run: () => { void detachSession(); }, enabled: () => !!activeView()?.attached },
  { name: 'Close active terminal', icon: 'close', run: () => { if (activeId) void closeSession(activeId); }, enabled: () => !!activeView() },
  { name: 'Refresh session list', icon: 'terminal', run: () => { void refreshSessions(); }, enabled: () => connection === 'connected' },
  { name: 'Shell profiles', icon: 'terminal', run: openProfiles },
  { name: 'Terminal settings', icon: 'settings', run: openSettings },
  { name: 'ChatGPT terminal access', icon: 'plug', run: () => { void openAgent(); } },
  { name: 'Setup and keyboard shortcuts', icon: 'help', run: () => $<HTMLDialogElement>('help-dialog').showModal() },
  { name: 'End all native sessions', icon: 'power', run: () => { void shutdown(); }, enabled: () => connection === 'connected' },
];
let paletteIndex = 0;
let paletteMatches: PaletteCommand[] = [];

function renderPalette(): void {
  const query = $<HTMLInputElement>('palette-input').value.toLowerCase().trim();
  paletteMatches = commands.filter(command => (!command.enabled || command.enabled()) && command.name.toLowerCase().includes(query));
  paletteIndex = Math.max(0, Math.min(paletteIndex, paletteMatches.length - 1));
  const result = $('palette-results');
  result.replaceChildren();
  for (const [index, command] of paletteMatches.entries()) {
    const row = element('button', `palette-command${index === paletteIndex ? ' selected' : ''}`);
    row.id = `palette-option-${index}`;
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === paletteIndex));
    row.tabIndex = -1;
    row.append(icon(command.icon), element('span', '', command.name));
    if (command.shortcut) row.append(element('kbd', '', command.shortcut));
    row.addEventListener('click', () => executePalette(command));
    result.append(row);
  }
  if (!paletteMatches.length) result.append(element('p', 'empty-sessions', 'No matching commands.'));
  $<HTMLInputElement>('palette-input').setAttribute('aria-activedescendant', `palette-option-${paletteIndex}`);
}

function executePalette(command: PaletteCommand): void {
  $<HTMLDialogElement>('palette-dialog').close();
  command.run();
}

function openPalette(): void {
  const dialog = $<HTMLDialogElement>('palette-dialog');
  if (dialog.open) { dialog.close(); return; }
  $<HTMLInputElement>('palette-input').value = '';
  paletteIndex = 0;
  renderPalette();
  dialog.showModal();
  $<HTMLInputElement>('palette-input').focus();
}

async function refreshSessions(fromAgent = false): Promise<void> {
  if (connection !== 'connected') return;
  sessionRefreshFromAgent ||= fromAgent;
  if (sessionRefresh) { sessionRefreshAgain = true; return sessionRefresh; }
  sessionRefresh = (async () => {
    do {
      sessionRefreshAgain = false;
      const agentPass = sessionRefreshFromAgent;
      sessionRefreshFromAgent = false;
      try {
        const current = await client.request<SessionInfo[]>('list');
        const newIds = current.filter(session => !sessions.has(session.id)).map(session => session.id);
        sessions.clear();
        for (const session of current) sessions.set(session.id, session);
        for (const [id, view] of views) {
          const currentSession = sessions.get(id);
          if (currentSession) view.session = currentSession;
          else { view.stale = true; view.attached = false; }
        }
        // Agent-created terminals become visible without stealing keyboard focus.
        if (agentPass || sessionRefreshFromAgent) for (const id of newIds) if (!views.has(id)) await attachSession(id);
        renderSessions();
        if (!agentPass && !sessionRefreshFromAgent) toast('Session list refreshed.');
      } catch (error) { if (connection === 'connected') toast(messageOf(error), true); }
    } while (sessionRefreshAgain && connection === 'connected');
  })();
  try { await sessionRefresh; } finally { sessionRefresh = null; }
}

async function adjustFont(delta: number): Promise<void> {
  preferences.fontSize = Math.max(9, Math.min(32, preferences.fontSize + delta));
  applyPreferences();
  try { await savePreferences(preferences); } catch { toast('Could not persist font size.', true); }
}

/** Returns true only for application shortcuts; standard terminal control keys stay untouched. */
function handleShortcut(event: KeyboardEvent): boolean {
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const hasDialog = document.querySelector('dialog[open]') !== null;
  if (modifier && event.shiftKey && key === 'p' && !hasDialog) { event.preventDefault(); openPalette(); return true; }
  if (hasDialog) return false;
  if (modifier && event.shiftKey && key === 'enter') { event.preventDefault(); void createSession(shellProfile()); return true; }
  if (modifier && event.shiftKey && key === 'f') { event.preventDefault(); openSearch(); return true; }
  if (modifier && event.shiftKey && key === 'c' && activeView()) { event.preventDefault(); void copySelection(); return true; }
  if (modifier && event.shiftKey && (key === '+' || key === '=' || key === '_' || key === '-')) { event.preventDefault(); void adjustFont(key === '+' || key === '=' ? 1 : -1); return true; }
  if (event.altKey && !modifier && (key === '[' || key === ']')) { event.preventDefault(); cycleSession(key === '[' ? -1 : 1); return true; }
  return false;
}

function bind(): void {
  $('connect-button').addEventListener('click', () => { if (connection === 'connected') void createSession(shellProfile()); else void connectHost(); });
  $('reconnect-button').addEventListener('click', () => { void connectHost(); });
  for (const id of ['new-terminal', 'sidebar-new']) $(id).addEventListener('click', () => { void createSession(shellProfile()); });
  $('toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('layout-select').addEventListener('change', event => changeLayout((event.target as HTMLSelectElement).value as Layout));
  $('settings-button').addEventListener('click', openSettings);
  $('agent-button').addEventListener('click', () => { void openAgent(); });
  $('agent-enable').addEventListener('click', () => { void changeBridge(true); });
  $('agent-disable').addEventListener('click', () => { void changeBridge(false); });
  $('copy-agent-descriptor').addEventListener('click', () => { if (bridge.descriptorPath) void copyText(bridge.descriptorPath, 'Bridge file path copied.'); });
  $('profiles-button').addEventListener('click', openProfiles);
  for (const id of ['help-button', 'setup-help']) $(id).addEventListener('click', () => $<HTMLDialogElement>('help-dialog').showModal());
  $('disconnect-all').addEventListener('click', () => { void shutdown(); });
  $('copy-extension-id').addEventListener('click', () => { void copyText(client.extensionId, 'Extension ID copied.'); });
  $('copy-install-command').addEventListener('click', () => { void copyText($('install-command').textContent || '', 'Install command copied.'); });
  $('copy-button').addEventListener('click', () => { void copySelection(); });
  $('paste-button').addEventListener('click', () => { void pasteClipboard(); });
  $('export-button').addEventListener('click', () => exportTranscript());
  $('rename-form').addEventListener('submit', event => { void renameSession(event as SubmitEvent); });
  $('settings-form').addEventListener('submit', event => { void submitSettings(event as SubmitEvent); });
  $('profiles-form').addEventListener('submit', event => { void saveProfiles(event as SubmitEvent); });
  $('search-button').addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-next').addEventListener('click', () => runSearch('next'));
  $('search-prev').addEventListener('click', () => runSearch('prev'));
  $('search-input').addEventListener('input', () => runSearch('next', true));
  $('search-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); runSearch(event.shiftKey ? 'prev' : 'next'); }
    if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
  });
  for (const id of ['search-case', 'search-regex']) $(id).addEventListener('change', () => runSearch('next', true));
  document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.close;
    if (id) $<HTMLDialogElement>(id).close();
    focusTerminal();
  }));
  $('edit-profile-select').addEventListener('change', () => {
    const next = $<HTMLSelectElement>('edit-profile-select').value;
    if (!captureProfileDraft()) { $<HTMLSelectElement>('edit-profile-select').value = editingProfile; return; }
    editingProfile = next;
    renderProfileEditor();
  });
  $('add-profile').addEventListener('click', () => {
    if (!captureProfileDraft()) return;
    if (profileDrafts.length >= 50) { toast('A maximum of 50 profiles is supported.', true); return; }
    const profile: ShellProfile = { id: crypto.randomUUID(), name: 'New profile', shell: '', args: [], cwd: '', env: {} };
    profileDrafts.push(profile);
    editingProfile = profile.id;
    renderProfileEditor();
    $<HTMLInputElement>('profile-name').focus();
    $<HTMLInputElement>('profile-name').select();
  });
  $('delete-profile').addEventListener('click', () => {
    if (profileDrafts.length <= 1) return;
    profileDrafts = profileDrafts.filter(profile => profile.id !== editingProfile);
    editingProfile = profileDrafts[0]!.id;
    renderProfileEditor();
  });
  $('export-settings').addEventListener('click', () => downloadFile('host-terminal-settings.json', exportPreferences(preferences), 'application/json'));
  $('import-settings').addEventListener('click', () => $<HTMLInputElement>('import-settings-file').click());
  $('import-settings-file').addEventListener('change', async () => {
    const input = $<HTMLInputElement>('import-settings-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('Settings file exceeds 256 KiB.');
      const candidate = importPreferences(await file.text());
      if (!await confirmAction('Import terminal settings?', 'This replaces your appearance and shell profiles. Imported profiles may launch arbitrary local executables when you select New terminal. Review profiles before launching them.', 'Import settings')) return;
      await savePreferences(candidate);
      preferences = candidate;
      applyPreferences();
      openSettings();
      toast('Settings imported. Review shell profiles before starting a terminal.');
    } catch (error) { toast(messageOf(error), true); }
  });
  $('reset-settings').addEventListener('click', async () => {
    if (!await confirmAction('Reset terminal settings?', 'This removes custom shell profiles and restores the default appearance. Existing sessions continue running.', 'Reset settings')) return;
    try { await savePreferences(DEFAULTS); preferences = structuredClone(DEFAULTS); applyPreferences(); openSettings(); toast('Default settings restored.'); }
    catch (error) { toast(messageOf(error), true); }
  });
  $('command-palette').addEventListener('click', openPalette);
  $('palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  $('palette-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteMatches.length) % (paletteMatches.length || 1);
      renderPalette();
      document.getElementById(`palette-option-${paletteIndex}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') { event.preventDefault(); const command = paletteMatches[paletteIndex]; if (command) executePalette(command); }
  });
  document.addEventListener('keydown', event => {
    // xterm's custom handler has already consumed its own shortcuts.
    if (!event.defaultPrevented) handleShortcut(event);
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target as Element;
    if (!target.closest('.sidebar') && !target.closest('#toggle-sidebar')) document.body.classList.remove('sidebar-open');
  });
  window.addEventListener('pagehide', () => client.disconnect());
}

async function initialize(): Promise<void> {
  try { preferences = await loadPreferences(); }
  catch { toast('Settings could not be read. Using defaults for this page.', true); }
  applyPreferences();
  bind();
  client.onEvent(handleEvent);
  $('extension-id').textContent = client.extensionId;
  const windows = /Win/u.test(navigator.platform);
  const command = `${windows ? '.\\host-terminal.exe' : './host-terminal'} install --extension-id ${client.extensionId}`;
  $('install-command').textContent = command;
  $('help-install-command').textContent = command;
  setConnection('disconnected');
  renderSessions();
  renderLayout();
}

void initialize().catch(error => {
  $('connect-error').textContent = `Could not initialize terminal: ${messageOf(error)}`;
  $('connect-error').hidden = false;
});
