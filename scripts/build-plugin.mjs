import { build } from 'esbuild';
import { readFile, writeFile, readdir, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'plugin/server');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['mcp/index.mjs'],
  outfile: path.join(output, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  metafile: true,
  banner: { js: "import { createRequire as hostTerminalCreateRequire } from 'node:module'; const require = hostTerminalCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
const dependencies = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.replaceAll('\\', '/').split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) continue;
  dependencies.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/'));
}
let notices = 'Host Terminal ChatGPT plugin: bundled third-party components.\n\n';
for (const dependency of [...dependencies].sort()) {
  const directory = path.join(root, dependency);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  notices += `===== ${pkg.name} ${pkg.version} (${pkg.license ?? 'see license'}) =====\n`;
  const names = (await readdir(directory)).filter(name => /^(license|copying)([._-]|$)/i.test(name));
  if (!names.length) throw new Error(`Bundled dependency has no license file: ${pkg.name}`);
  for (const name of names.sort()) {
    try { notices += await readFile(path.join(directory, name), 'utf8'); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
    notices += '\n';
  }
  notices += '\n';
}
await writeFile(path.join(root, 'plugin/THIRD_PARTY_NOTICES.txt'), notices);
await cp(path.join(root, 'LICENSE'), path.join(root, 'plugin/LICENSE'));
console.log(`Built self-contained MCP plugin: ${output}`);
