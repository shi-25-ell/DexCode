import { existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export type ShellKind = 'powershell' | 'bash';

export type ResolvedShellRuntime = {
  kind: ShellKind;
  executable: string;
  args: string[];
  source: 'configured' | 'path' | 'standard_location';
  version: string;
  description: string;
};

export type ShellCapabilitySnapshot = {
  selected: ResolvedShellRuntime;
  available: ResolvedShellRuntime[];
};

export type ShellResolverOptions = {
  preferred?: ShellKind;
  powershellPath?: string;
  bashPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function executable(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

function fromPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const entry of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    if (executable(candidate)) return resolve(candidate);
  }
  return undefined;
}

function version(path: string, args: string[]): string | undefined {
  const result = spawnSync(path, args, { windowsHide: true, encoding: 'utf8', timeout: 5_000 });
  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function powershellCandidate(options: ShellResolverOptions): ResolvedShellRuntime | undefined {
  const env = options.env ?? process.env;
  const candidates: Array<{ path?: string; source: ResolvedShellRuntime['source'] }> = [
    { path: options.powershellPath, source: 'configured' },
    { path: fromPath('pwsh.exe', env) ?? fromPath('pwsh', env), source: 'path' },
    { path: fromPath('powershell.exe', env) ?? fromPath('powershell', env), source: 'path' },
  ];
  for (const candidate of candidates) {
    if (!candidate.path || !executable(candidate.path)) continue;
    const detected = version(candidate.path, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    if (!detected) continue;
    return {
      kind: 'powershell',
      executable: candidate.path,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      source: candidate.source,
      version: detected,
      description: `PowerShell ${detected}`,
    };
  }
  return undefined;
}

function bashCandidate(options: ShellResolverOptions): ResolvedShellRuntime | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates: Array<{ path?: string; source: ResolvedShellRuntime['source'] }> = [];
  if (options.bashPath) candidates.push({ path: options.bashPath, source: 'configured' });
  if (platform === 'win32') {
    if (env.ProgramFiles) candidates.push({ path: join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'), source: 'standard_location' });
    if (env['ProgramFiles(x86)']) candidates.push({ path: join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'), source: 'standard_location' });
  }
  candidates.push({ path: fromPath(platform === 'win32' ? 'bash.exe' : 'bash', env), source: 'path' });
  for (const candidate of candidates) {
    if (!candidate.path || !executable(candidate.path)) continue;
    if (platform === 'win32' && /[\\/]windows[\\/]system32[\\/]bash\.exe$/i.test(candidate.path)) continue;
    const detected = version(candidate.path, ['--version']);
    if (!detected || !/bash/i.test(detected)) continue;
    return {
      kind: 'bash',
      executable: candidate.path,
      args: ['--noprofile', '--norc'],
      source: candidate.source,
      version: detected,
      description: detected,
    };
  }
  return undefined;
}

export function resolveShellCapabilities(options: ShellResolverOptions = {}): ShellCapabilitySnapshot {
  const platform = options.platform ?? process.platform;
  const powershell = powershellCandidate(options);
  const bash = bashCandidate(options);
  const available = [powershell, bash].filter((entry): entry is ResolvedShellRuntime => Boolean(entry));
  const preferred = options.preferred ?? (platform === 'win32' ? 'powershell' : 'bash');
  const frozenAvailable = available.map((entry) => Object.freeze({ ...entry, args: Object.freeze([...entry.args]) as string[] }));
  const selected = frozenAvailable.find((entry) => entry.kind === preferred);
  if (!selected) throw new Error(`Configured shell is unavailable: ${preferred}`);
  return Object.freeze({ selected, available: Object.freeze(frozenAvailable) as ResolvedShellRuntime[] });
}
