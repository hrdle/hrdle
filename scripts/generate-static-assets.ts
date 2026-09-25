#!/usr/bin/env bun
// Generate embedded static assets from frontend build

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, dirname } from 'path';

const scriptDir = dirname(new URL(import.meta.url).pathname);
const FRONTEND_DIST = join(scriptDir, '../frontend/dist');
// Glasses simulator, built with --base=/glasses/ so it can be mounted under
// that prefix. Lets anyone open the G2 UI without the hardware.
const GLASSES_DIST = join(scriptDir, '../glasses/dist-web');
const OUTPUT_FILE = join(scriptDir, '../backend/src/static-assets.ts');

interface AssetEntry {
  content: string; // base64
  contentType: string;
}

function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    'html': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
  };
  return types[ext || ''] || 'application/octet-stream';
}

function scanDirectory(dir: string, assets: Record<string, AssetEntry> = {}, baseDir: string = dir): Record<string, AssetEntry> {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      scanDirectory(fullPath, assets, baseDir);
    } else {
      const relativePath = '/' + relative(baseDir, fullPath);
      const content = readFileSync(fullPath);
      assets[relativePath] = {
        content: content.toString('base64'),
        contentType: getContentType(entry),
      };
    }
  }

  return assets;
}

console.log('Scanning frontend dist...');
const assets = scanDirectory(FRONTEND_DIST);
console.log(`Found ${Object.keys(assets).length} files`);

if (existsSync(GLASSES_DIST)) {
  const glasses = scanDirectory(GLASSES_DIST);
  for (const [path, entry] of Object.entries(glasses)) {
    assets[`/glasses${path}`] = entry;
  }
  console.log(`Found ${Object.keys(glasses).length} glasses simulator files (mounted at /glasses)`);
} else {
  // Not fatal: a binary without it simply has no simulator route.
  console.warn('glasses/dist-web missing — skipping the simulator (run: bun run --filter glasses build:web)');
}

const output = `// Auto-generated static assets - DO NOT EDIT
// Generated at: ${new Date().toISOString()}

export const STATIC_ASSETS: Record<string, { content: string; contentType: string }> = ${JSON.stringify(assets, null, 2)};

export function getStaticAsset(path: string): { content: Buffer; contentType: string } | null {
  // Normalize path
  let normalizedPath = path.startsWith('/') ? path : '/' + path;

  // Try exact match
  let asset = STATIC_ASSETS[normalizedPath];

  // Try with /index.html for directories
  if (!asset && !normalizedPath.includes('.')) {
    asset = STATIC_ASSETS[normalizedPath + '/index.html'] || STATIC_ASSETS[normalizedPath + 'index.html'];
  }

  if (!asset) return null;

  return {
    content: Buffer.from(asset.content, 'base64'),
    contentType: asset.contentType,
  };
}

export function hasStaticAsset(path: string): boolean {
  return getStaticAsset(path) !== null;
}
`;

writeFileSync(OUTPUT_FILE, output);
console.log(`Generated: ${OUTPUT_FILE}`);
