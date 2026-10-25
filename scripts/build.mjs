import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist/extension');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { terminal: 'extension/src/terminal.ts', worker: 'extension/src/worker.ts' },
  outdir: out, bundle: true, minify: true, sourcemap: true, target: 'chrome116',
  platform: 'browser', format: 'esm', legalComments: 'eof', logLevel: 'info'
});
for (const file of ['manifest.json', 'terminal.html', 'EXTENSION_ID', 'icons']) {
  await cp(path.join(root, 'extension', file), path.join(out, file), { recursive: true });
}
const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join('');
if (id !== (await readFile(path.join(out, 'EXTENSION_ID'), 'utf8')).trim()) throw new Error('Manifest public key changed; update EXTENSION_ID');
let notices = 'Host Terminal bundles these open source terminal components.\n\n';
for (const name of (await readdir(path.join(root, 'node_modules/@xterm'))).sort()) {
  const dir = path.join(root, 'node_modules/@xterm', name);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const licenseName = (await readdir(dir)).find(file => /^LICENSE/i.test(file));
  notices += `===== ${pkg.name} ${pkg.version} (${pkg.license}) =====\n`;
  notices += licenseName ? await readFile(path.join(dir, licenseName), 'utf8') : `See ${pkg.homepage ?? pkg.name}\n`;
  notices += '\n\n';
}
await writeFile(path.join(out, 'THIRD_PARTY_NOTICES.txt'), notices);
console.log(`Built unpacked extension: ${out}\nExtension ID: ${id}`);
