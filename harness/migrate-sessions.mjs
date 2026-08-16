import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sessionRoot, legacyRoot, installDir] = process.argv.slice(2);
if (!sessionRoot || !legacyRoot || !installDir) throw new Error('sessionRoot, legacyRoot, and installDir are required');

const zstdUrl = pathToFileURL(path.join(
  installDir,
  'packages',
  'session',
  'session-persistence-jsonl',
  'lib',
  'types',
  'zstd.js',
)).href;
const { createZstdFrameDecoder, scanZstdFrames } = await import(zstdUrl);

function filesBelow(root, name) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(target, name));
    else if (entry.name === name) found.push(target);
  }
  return found;
}

let converted = 0;
for (const source of filesBelow(sessionRoot, 'session.jsonl.zstd')) {
  const target = source.slice(0, -'.zstd'.length);
  const backup = `${source}.bak`;
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
  if (fs.existsSync(backup)) throw new Error(`backup already exists without ${target}: ${backup}`);
  const compressed = fs.readFileSync(source);
  const { frames, tornStart } = scanZstdFrames(compressed);
  if (tornStart !== undefined) throw new Error(`incomplete zstd frame in ${source}`);
  const chunks = [];
  for (const chunk of createZstdFrameDecoder().decode(compressed, frames)) chunks.push(Buffer.from(chunk));
  const plaintext = Buffer.concat(chunks);
  const first = JSON.parse(plaintext.toString('utf8', 0, plaintext.indexOf(10)));
  if (first?.type !== 'session') throw new Error(`invalid session header in ${source}`);
  const temporary = `${target}.migrating`;
  fs.writeFileSync(temporary, plaintext, { flag: 'wx' });
  fs.renameSync(source, backup);
  fs.renameSync(temporary, target);
  converted++;
}

let copied = 0;
for (const source of filesBelow(legacyRoot, 'session.jsonl')) {
  const relative = path.relative(legacyRoot, source);
  const target = path.join(sessionRoot, relative);
  if (fs.existsSync(target)) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  copied++;
}

process.stdout.write(JSON.stringify({ converted, copied }));
