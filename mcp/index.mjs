#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient, BridgeError } from './bridge.mjs';
import { createMcpServer, VERSION } from './tools.mjs';
import { initializeToken, loadHttpToken, normalizeOrigin, startHttpServer } from './http.mjs';

const HELP = `Host Terminal MCP ${VERSION}

Usage:
  node server/index.mjs                          MCP over stdio (default)
  node server/index.mjs --bridge-file PATH        Override bridge discovery
  node server/index.mjs --init-token PATH         Create a private HTTP bearer token
  node server/index.mjs --http --token-file PATH  MCP on http://127.0.0.1:8767/mcp

Options:
  --http                  Start an authenticated loopback Streamable HTTP endpoint
  --port PORT             HTTP port (default 8767; 0 selects an available port)
  --token-file PATH       Read a private HTTP token file; never print its content
  --allowed-origin URL    Allow an additional exact HTTPS origin (repeatable)
  --bridge-file PATH      Path to the extension native host's agent-bridge.json
  --init-token PATH       Create token file without overwriting existing files, then exit
  --help                  Show this help
  --version               Show the server version

Environment:
  HOST_TERMINAL_BRIDGE_FILE      Override native bridge descriptor discovery
  HOST_TERMINAL_MCP_TOKEN_FILE   HTTP token file if --token-file is omitted
  HOST_TERMINAL_MCP_TOKEN        HTTP token if no explicit --token-file is given

Open Host Terminal in Chrome and enable ChatGPT access before calling tools.
The server attaches to the Chrome-owned native host; it never launches its own host.
HTTP binds only to 127.0.0.1. Use an explicitly configured Secure MCP Tunnel for
remote clients; this executable never starts a tunnel or exposes a public port.
`;

export function parseArguments(argv) {
  const options = { http: false, port: 8767, allowedOrigins: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--http') options.http = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version') options.version = true;
    else if (['--port', '--token-file', '--bridge-file', '--allowed-origin', '--init-token'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new BridgeError('invalid_arguments', `${arg} requires a value.`);
      if (arg === '--port') {
        if (!/^\d+$/.test(value) || Number(value) > 65_535) throw new BridgeError('invalid_arguments', '--port must be an integer from 0 to 65535.');
        options.port = Number(value);
      } else if (arg === '--token-file') options.tokenFile = resolve(value);
      else if (arg === '--bridge-file') options.descriptorPath = resolve(value);
      else if (arg === '--allowed-origin') options.allowedOrigins.push(normalizeOrigin(value));
      else options.initToken = resolve(value);
    } else throw new BridgeError('invalid_arguments', `Unknown option: ${arg}`);
  }
  if (!options.http && (options.tokenFile || options.allowedOrigins.length || options.port !== 8767)) throw new BridgeError('invalid_arguments', '--port, --token-file and --allowed-origin require --http.');
  if (options.initToken && options.http) throw new BridgeError('invalid_arguments', '--init-token creates a token and exits; run --http separately.');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (options.initToken) { process.stderr.write(`Created HTTP token file: ${await initializeToken(options.initToken)}\n`); return; }
  const bridge = new BridgeClient({ descriptorPath: options.descriptorPath });
  let close;
  if (options.http) {
    const token = await loadHttpToken(options);
    const endpoint = await startHttpServer({ bridge, token, port: options.port, allowedOrigins: options.allowedOrigins });
    process.stderr.write(`Host Terminal MCP listening at ${endpoint.url}; bearer authentication required.\n`);
    close = () => endpoint.close();
  } else {
    const server = createMcpServer({ bridge });
    await server.connect(new StdioServerTransport());
    close = () => server.close();
    process.stdin.once('end', () => { void close(); });
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Host Terminal MCP: ${error instanceof BridgeError ? error.message : 'Startup failed. Check paths, permissions and Node.js version.'}\n`);
    process.exitCode = 1;
  });
}
