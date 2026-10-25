import { chromium, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = process.env.HOST_TERMINAL_BINARY || path.join(root, 'target/debug/host-terminal');
const extension = path.join(root, 'dist/extension');
const id = (await readFile(path.join(extension, 'EXTENSION_ID'), 'utf8')).trim();
const temporary = await mkdtemp(path.join(tmpdir(), 'host-terminal-browser-'));
const profile = path.join(temporary, 'profile');
const install = path.join(temporary, 'native');
const evidence = path.join(root, 'test-results');
await mkdir(evidence, { recursive: true });
execFileSync(binary, ['install', '--extension-id', id, '--browser', 'chromium', '--install-dir', install, '--manifest-dir', path.join(profile, 'NativeMessagingHosts')]);

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 980 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
});
const page = await context.newPage();
const errors = [];
let mcp;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function transcript() {
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloaded;
  return (await readFile(await download.path(), 'utf8')).slice(-6000);
}
async function type(command) {
  const input = page.locator('.terminal-pane.active .xterm-helper-textarea');
  await input.focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');
}

try {
  await page.goto(`chrome-extension://${id}/terminal.html`);
  await expect(page.locator('#extension-id')).toHaveText(id);
  await page.screenshot({ path: path.join(evidence, 'onboarding.png'), fullPage: true });
  await page.locator('#connect-button').click();
  await expect(page.locator('#footer-status')).toHaveText('Connected', { timeout: 15000 });
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  await type("printf 'BROWSER_%s\\n' 'PTY_OK 🦀'");
  await expect.poll(transcript, { timeout: 10000 }).toContain('BROWSER_PTY_OK 🦀');
  await type("printf '\\033[31mCOLOR_OK\\033[0m\\n'; stty size");
  await expect.poll(transcript).toContain('COLOR_OK');

  await page.locator('#new-terminal').click();
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  await type("printf 'SECOND_%s\\n' 'SESSION_OK'");
  await expect.poll(transcript).toContain('SECOND_SESSION_OK');
  await page.locator('#layout-select').selectOption('columns');
  await expect(page.locator('.terminal-pane:not(.pane-hidden)')).toHaveCount(2);

  await page.locator('.terminal-pane.active [aria-label="Rename terminal"]').click();
  await page.locator('#rename-input').fill('Build workspace');
  await page.locator('#rename-form button[type="submit"]').click();
  await expect(page.locator('.terminal-pane.active .pane-title')).toContainText('Build workspace');

  await page.locator('#search-button').click();
  await page.locator('#search-input').fill('SECOND_SESSION_OK');
  await expect(page.locator('#search-results')).toHaveText(/^\d+ \/ [1-9]\d*$/);
  await page.locator('#search-close').click();
  await page.locator('#settings-button').click();
  await page.locator('#setting-theme').selectOption('graphite');
  await page.locator('#setting-font-size').fill('15');
  await page.locator('#settings-form button[type="submit"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');

  // A real page reload drops only the UI port. Native sessions and their PIDs survive.
  await page.reload();
  await page.locator('#connect-button').click();
  await expect(page.locator('#footer-status')).toHaveText('Connected');
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  await page.getByRole('tab', { name: 'Build workspace', exact: true }).click();
  await expect.poll(transcript).toContain('SECOND_SESSION_OK');

  await page.locator('#layout-select').selectOption('columns');
  await page.screenshot({ path: path.join(evidence, 'workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#layout-select').selectOption('single');
  await page.screenshot({ path: path.join(evidence, 'compact.png'), fullPage: true });
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  const overlap = await page.evaluate(() => {
    const launch = document.querySelector('#new-terminal').getBoundingClientRect();
    const actions = document.querySelector('.toolbar-actions').getBoundingClientRect();
    return Math.max(0, Math.min(launch.right, actions.right) - Math.max(launch.left, actions.left)) *
      Math.max(0, Math.min(launch.bottom, actions.bottom) - Math.max(launch.top, actions.top));
  });
  expect(overlap).toBe(0);
  await page.setViewportSize({ width: 1440, height: 980 });

  // Exceed the native output window: completion requires ACKs from the actual xterm renderer.
  await page.locator('#new-terminal').click();
  await type("yes FLOW | head -n 60000; printf 'FLOW_%s\\n' 'DONE'");
  await expect.poll(transcript, { timeout: 20000 }).toContain('FLOW_DONE');
  await type("printf 'SLEEP_%s\\n' 'READY'; sleep 60");
  await expect.poll(transcript).toContain('SLEEP_READY');
  await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await expect.poll(async () => (await transcript()).slice(-160)).toMatch(/[$#>%]\s*$/);
  await type("printf 'INTERRUPT_%s\\n' 'OK'");
  await expect.poll(transcript, { timeout: 10000 }).toContain('INTERRUPT_OK');

  // Native paste event must be reviewed once and must not execute before acceptance.
  await page.locator('.terminal-pane.active .xterm-helper-textarea').evaluate(input => {
    const data = new DataTransfer();
    data.setData('text/plain', "printf 'PASTE_%s\\n' 'REVIEWED'\n");
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Review terminal paste');
  await page.locator('#confirm-accept').click();
  await expect.poll(transcript).toContain("printf 'PASTE_%s\\n' 'REVIEWED'");
  // Bracketed-paste-aware shells may insert the trailing newline without submitting it.
  await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await expect.poll(transcript).toContain('PASTE_REVIEWED');
  // Exercise the packaged MCP server against this exact Chrome-owned native process.
  mcp = new Client({ name: 'host-terminal-browser-test', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'plugin/server/index.mjs')],
    env: { ...process.env, HOST_TERMINAL_BRIDGE_FILE: path.join(install, 'agent-bridge.json') },
  }));
  const call = async (name, args = {}) => {
    const response = await mcp.callTool({ name, arguments: args });
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  expect((await call('terminal_list')).ok).toBe(false);
  await page.locator('#agent-button').click();
  await expect(page.locator('#agent-status')).toHaveText('ChatGPT access is off');
  await page.locator('#agent-enable').click();
  await expect(page.locator('#agent-status')).toHaveText('ChatGPT access is enabled');
  await expect(page.locator('#agent-descriptor')).toHaveText(path.join(install, 'agent-bridge.json'));
  await page.screenshot({ path: path.join(evidence, 'chatgpt-access.png'), fullPage: true });
  await page.locator('#agent-dialog [data-close="agent-dialog"]').first().click();
  const status = await call('host_status');
  expect(status.ok).toBe(true);
  expect(status.data.host.version).toBe('0.2.0');
  const listed = await call('terminal_list');
  expect(listed.ok).toBe(true);
  const shared = listed.data.sessions.find(session => session.title === 'Build workspace');
  expect(shared).toBeTruthy();
  const written = await call('terminal_write', {
    sessionId: shared.id, text: "printf 'MCP_SHARED_%s\\n' 'STREAM'", appendNewline: true,
  });
  expect(written.ok).toBe(true);
  await page.getByRole('tab', { name: 'Build workspace', exact: true }).click();
  await expect.poll(transcript).toContain('MCP_SHARED_STREAM');
  const read = await call('terminal_read', { sessionId: shared.id, cursor: 0, waitMs: 1000 });
  expect(read.ok).toBe(true);
  expect(read.data.text).toContain('MCP_SHARED_STREAM');
  const run = await call('terminal_run', {
    command: "printf 'MCP_%s\\n' 'RUN_OK'", title: 'ChatGPT integration', waitMs: 5000,
  });
  expect(run.ok).toBe(true);
  expect(run.data.text).toContain('MCP_RUN_OK');
  expect(run.data.exited).toBe(true);
  expect(run.data.exitCode).toBe(0);
  await expect(page.getByRole('tab', { name: 'ChatGPT integration', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'ChatGPT integration', exact: true }).click();
  await expect.poll(transcript).toContain('MCP_RUN_OK');
  const renamed = await call('terminal_rename', { sessionId: run.data.sessionId, title: 'ChatGPT verified' });
  expect(renamed.ok).toBe(true);
  await expect(page.getByRole('tab', { name: 'ChatGPT verified', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'chatgpt-session.png'), fullPage: true });
  expect((await call('terminal_close', { sessionId: run.data.sessionId })).ok).toBe(true);
  await page.locator('#agent-button').click();
  await page.locator('#agent-disable').click();
  await expect(page.locator('#agent-status')).toHaveText('ChatGPT access is off');
  expect((await call('terminal_list')).ok).toBe(false);
  await page.locator('#agent-dialog [data-close="agent-dialog"]').first().click();
  await page.getByRole('tab', { name: 'Build workspace', exact: true }).click();
  await type("printf 'AFTER_REVOKE_%s\\n' 'OK'");
  await expect.poll(transcript).toContain('AFTER_REVOKE_OK');
  await page.locator('#disconnect-all').click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#footer-status')).toHaveText('Disconnected');
  expect(errors).toEqual([]);
  console.log('Browser integration passed: real native shell, Unicode, ANSI, resize, multiple sessions, splits, rename, search, settings persistence, reload/reattach, compact viewport, output backpressure, Ctrl+C, paste review, packaged MCP tool discovery and shared-session execution, UI synchronization, access revocation, shutdown.');
} catch (error) {
  console.error('Extension errors:', errors);
  console.error((await page.locator('body').innerText()).slice(-7000));
  await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await mcp?.close();
  await context.close();
  await rm(temporary, { recursive: true, force: true });
}
