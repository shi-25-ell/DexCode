import { execFile, spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export class ManagedToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'ManagedToolError';
  }
}

export type EnsureRgOptions = {
  managedDir: string;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
};

const inflight = new Map<string, Promise<string>>();

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const names = platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  return String(env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((entry) => names.map((name) => join(entry, name)));
}

function probeVersion(path: string): Promise<void> {
  return new Promise((resolveProbe, reject) => {
    execFile(path, ['--version'], { windowsHide: true }, (error, stdout) => {
      if (error || !/^ripgrep\s+\d+/i.test(String(stdout))) {
        reject(new ManagedToolError('version_probe_failed', `ripgrep version probe failed for ${path}`, { cause: error }));
        return;
      }
      resolveProbe();
    });
  });
}

function releaseAsset(platform: NodeJS.Platform, arch: NodeJS.Architecture): RegExp {
  if (platform === 'win32' && arch === 'x64') return /x86_64-pc-windows-msvc\.zip$/;
  if (platform === 'win32' && arch === 'arm64') return /aarch64-pc-windows-msvc\.zip$/;
  if (platform === 'linux' && arch === 'x64') return /x86_64-unknown-linux-musl\.tar\.gz$/;
  if (platform === 'linux' && arch === 'arm64') return /aarch64-unknown-linux-gnu\.tar\.gz$/;
  if (platform === 'darwin' && arch === 'x64') return /x86_64-apple-darwin\.tar\.gz$/;
  if (platform === 'darwin' && arch === 'arm64') return /aarch64-apple-darwin\.tar\.gz$/;
  throw new ManagedToolError('unsupported_platform', `No managed ripgrep release for ${platform}/${arch}`);
}

function extractArchive(archive: string, destination: string): Promise<void> {
  return new Promise((resolveExtract, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destination], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(new ManagedToolError('extract_failed', `Unable to start archive extractor: ${error.message}`, { cause: error })));
    child.on('close', (code) => code === 0
      ? resolveExtract()
      : reject(new ManagedToolError('extract_failed', stderr.trim() || `Archive extractor exited with ${code}`)));
  });
}

async function findExtractedExecutable(directory: string, fileName: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExtractedExecutable(candidate, fileName);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) return candidate;
  }
  return undefined;
}

async function install(options: EnsureRgOptions, platform: NodeJS.Platform, arch: NodeJS.Architecture): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let releaseResponse: Response;
  try {
    releaseResponse = await fetchImpl('https://api.github.com/repos/BurntSushi/ripgrep/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DexCode' },
    });
  } catch (error) {
    throw new ManagedToolError('download_failed', 'Unable to query the ripgrep release service', { cause: error });
  }
  if (!releaseResponse.ok) throw new ManagedToolError('download_failed', `ripgrep release service returned HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json() as { assets?: Array<{ name?: string; browser_download_url?: string }> };
  const pattern = releaseAsset(platform, arch);
  const asset = release.assets?.find((candidate) => pattern.test(String(candidate.name ?? '')));
  if (!asset?.browser_download_url || !asset.name) {
    throw new ManagedToolError('asset_not_found', `No ripgrep asset matched ${platform}/${arch}`);
  }

  const parent = dirname(options.managedDir);
  const temporary = resolve(parent, `.ripgrep-install-${crypto.randomUUID()}`);
  const archive = join(temporary, asset.name);
  const extracted = join(temporary, 'extracted');
  const executableName = platform === 'win32' ? 'rg.exe' : 'rg';
  const staged = join(temporary, executableName);
  try {
    await mkdir(extracted, { recursive: true });
    let assetResponse: Response;
    try {
      assetResponse = await fetchImpl(asset.browser_download_url, { headers: { 'User-Agent': 'DexCode' } });
    } catch (error) {
      throw new ManagedToolError('download_failed', 'Unable to download the ripgrep release asset', { cause: error });
    }
    if (!assetResponse.ok) throw new ManagedToolError('download_failed', `ripgrep asset returned HTTP ${assetResponse.status}`);
    await writeFile(archive, Buffer.from(await assetResponse.arrayBuffer()));
    await extractArchive(archive, extracted);
    const discovered = await findExtractedExecutable(extracted, executableName);
    if (!discovered) throw new ManagedToolError('extract_failed', `The archive did not contain ${executableName}`);
    await copyFile(discovered, staged);
    if (platform !== 'win32') await chmod(staged, 0o755);
    await probeVersion(staged);
    await mkdir(parent, { recursive: true });
    await rm(options.managedDir, { recursive: true, force: true });
    await rename(temporary, options.managedDir);
    return join(options.managedDir, executableName);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ManagedToolError) throw error;
    throw new ManagedToolError('publish_failed', 'Unable to publish managed ripgrep', { cause: error });
  }
}

export async function ensureRg(options: EnsureRgOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const executableName = platform === 'win32' ? 'rg.exe' : 'rg';
  const managed = join(options.managedDir, executableName);
  const key = `${resolve(options.managedDir)}:${platform}:${arch}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const work = (async () => {
    if (await executable(managed)) {
      await probeVersion(managed);
      return managed;
    }
    for (const candidate of pathCandidates(options.env ?? process.env, platform)) {
      if (await executable(candidate)) {
        await probeVersion(candidate);
        return candidate;
      }
    }
    if (options.offline) {
      throw new ManagedToolError('offline_missing', 'ripgrep is not installed and managed tool downloads are disabled; install rg on PATH or place it in the managed tool directory');
    }
    return install(options, platform, arch);
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
