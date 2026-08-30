import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a local port'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function stopProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // The process may already have exited after a failed startup.
  }
}

const runtimePort = await freePort();
const webPort = await freePort();
const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev'];
const child = spawn(command, commandArgs, {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    PORT: String(runtimePort),
    WEB_PORT: String(webPort),
    LLM_API_KEY: '',
    LLM_MODEL: 'mock',
    WORKSPACE_DIR: repoRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const capture = (chunk) => {
  output = `${output}${chunk.toString('utf8')}`.slice(-12_000);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

try {
  const deadline = Date.now() + 20_000;
  let lastFailure = 'development server did not respond';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`npm run dev exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/api/meta`);
      if (response.status === 200) {
        const body = await response.json();
        if (body?.appName !== 'DexCode') throw new Error('development proxy returned an unexpected application');
        console.log(JSON.stringify({ ok: true, webPort, runtimePort, status: response.status }));
        process.exitCode = 0;
        break;
      }
      lastFailure = `development proxy returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (process.exitCode !== 0) {
    throw new Error(`${lastFailure}\n--- npm run dev output ---\n${output}`);
  }
} finally {
  stopProcessTree(child);
}
