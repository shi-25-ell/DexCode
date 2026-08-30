import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function loadEnvFile(filePath: string) {
  try {
    const content = await readFile(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    return;
  }
}

await loadEnvFile(resolve(process.cwd(), '.env'));

const { startRuntimeServer } = await import('./apps/runtime/server.ts');

startRuntimeServer();
