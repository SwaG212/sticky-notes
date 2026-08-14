import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const installDir = process.env.DSH_INSTALL_DIR;
const configPath = process.env.DSH_CORDIS_CONFIG;

if (!installDir || !configPath) {
  process.stderr.write('sticky-harness-runtime: DSH_INSTALL_DIR and DSH_CORDIS_CONFIG are required\n');
  process.exit(1);
}

const appBootUrl = pathToFileURL(
  path.join(installDir, 'packages', 'boot', 'app-boot', 'lib', 'index.js'),
).href;
const { boot, installFailLoud } = await import(appBootUrl);

const name = 'sticky-harness-runtime';
installFailLoud(name);

function packageEntries(root) {
  const entries = new Map();
  const packagesRoot = path.join(root, 'packages');
  for (const group of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(packagesRoot, group.name);
    for (const item of fs.readdirSync(groupPath, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const manifestPath = path.join(groupPath, item.name, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name && manifest.main) {
        entries.set(manifest.name, pathToFileURL(path.join(path.dirname(manifestPath), manifest.main)).href);
      }
    }
  }
  return entries;
}

const entries = packageEntries(installDir);
const source = fs.readFileSync(configPath, 'utf8');
const resolved = source.replace(/name: '(@deepseek-ai\/[^']+)'/g, (match, packageName) => {
  const entry = entries.get(packageName);
  if (!entry || !fs.existsSync(new URL(entry))) throw new Error(`Harness plugin is unavailable: ${packageName}`);
  return `name: '${entry}'`;
});
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-harness-'));
const resolvedConfigPath = path.join(tempDir, 'cordis.yml');
fs.writeFileSync(resolvedConfigPath, resolved, 'utf8');
const ctx = await boot(name, resolvedConfigPath);
let exiting = false;

async function disposeAndExit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await ctx.fiber.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(code);
  }
}

process.stdin.on('end', () => { void disposeAndExit(0); });
process.on('SIGTERM', () => { void disposeAndExit(0); });
process.on('SIGINT', () => { void disposeAndExit(130); });
