import { zipSync } from 'fflate';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/');
    else if (!relative.endsWith('.map')) files[relative] = new Uint8Array(await readFile(path.join(directory, entry.name)));
  }
}
await collect(path.join(root, 'dist/extension'));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const name = `host-terminal-extension-${pkg.version}.zip`;
const bytes = zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
await writeFile(path.join(output, name), bytes);
await writeFile(path.join(output, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
console.log(path.join(output, name));
