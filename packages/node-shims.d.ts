declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  platform: string;
  arch: NodeJS.Architecture;
  pid: number;
};

declare namespace NodeJS {
  type ProcessEnv = Record<string, string | undefined>;
  type Platform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | string;
  type Architecture = 'arm' | 'arm64' | 'ia32' | 'loong64' | 'mips' | 'mipsel' | 'ppc' | 'ppc64' | 'riscv64' | 's390' | 's390x' | 'x64' | string;
}

declare type Buffer = {
  readonly byteLength: number;
  subarray(start: number, end?: number): Buffer;
  toString(encoding?: string): string;
};

declare const Buffer: {
  from(value: string | ArrayBuffer, encoding?: string): Buffer;
  byteLength(value: string, encoding?: string): number;
};

declare type FsDirent = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

declare module 'node:fs' {
  export type Dirent = FsDirent;
  export const constants: { F_OK: number; X_OK: number };
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
  export const promises: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readFile(path: string, options?: string): Promise<string>;
    writeFile(path: string, data: string | Buffer, options?: string | { encoding?: string; flag?: string; mode?: number }): Promise<void>;
    appendFile(path: string, data: string, options?: string | { encoding?: string; mode?: number }): Promise<void>;
    open(path: string, flags: string): Promise<{ writeFile(data: string, encoding?: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void>;
    cp(source: string, destination: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number }>;
    lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>;
    realpath(path: string): Promise<string>;
    readdir(path: string, options: { withFileTypes: true }): Promise<FsDirent[]>;
    readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
    access(path: string, mode?: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    copyFile(source: string, destination: string): Promise<void>;
  };
}

declare module 'node:fs/promises' {
  export const readFile: typeof import('node:fs').promises.readFile;
  export const writeFile: typeof import('node:fs').promises.writeFile;
  export const appendFile: typeof import('node:fs').promises.appendFile;
  export const open: typeof import('node:fs').promises.open;
  export const mkdir: typeof import('node:fs').promises.mkdir;
  export const cp: typeof import('node:fs').promises.cp;
  export const rename: typeof import('node:fs').promises.rename;
  export const rm: typeof import('node:fs').promises.rm;
  export const stat: typeof import('node:fs').promises.stat;
  export const lstat: typeof import('node:fs').promises.lstat;
  export const realpath: typeof import('node:fs').promises.realpath;
  export const readdir: typeof import('node:fs').promises.readdir;
  export const access: typeof import('node:fs').promises.access;
  export const chmod: typeof import('node:fs').promises.chmod;
  export const copyFile: typeof import('node:fs').promises.copyFile;
}

declare module 'fs' {
  export const promises: typeof import('node:fs').promises;
}

declare module 'fs/promises' {
  export const readFile: typeof import('node:fs').promises.readFile;
  export const writeFile: typeof import('node:fs').promises.writeFile;
  export const mkdir: typeof import('node:fs').promises.mkdir;
  export const cp: typeof import('node:fs').promises.cp;
  export const rename: typeof import('node:fs').promises.rename;
  export const rm: typeof import('node:fs').promises.rm;
  export const stat: typeof import('node:fs').promises.stat;
  export const lstat: typeof import('node:fs').promises.lstat;
  export const realpath: typeof import('node:fs').promises.realpath;
  export const readdir: typeof import('node:fs').promises.readdir;
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  export function matchesGlob(path: string, pattern: string): boolean;
  export const delimiter: string;
  export const sep: string;
}

declare module 'path' {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:http' {
  export type IncomingMessage = {
    url?: string;
    method?: string;
    headers: Record<string, string | undefined>;
    on(event: 'close', listener: () => void): void;
    on(event: 'data', listener: (chunk: string | Buffer) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: unknown) => void): void;
  };
  export type ServerResponse = {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    write(chunk: string): boolean;
    end(chunk?: string): void;
    on(event: 'close', listener: () => void): void;
    once(event: 'drain', listener: () => void): void;
  };
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): {
    listen(port: number, callback?: () => void): void;
  };
}

declare module 'http' {
  export { IncomingMessage, ServerResponse, createServer } from 'node:http';
}

declare module 'child_process' {
  export function execFile(
    file: string,
    args: string[],
    options: { cwd?: string; windowsHide?: boolean; maxBuffer?: number },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ): void;
  export function spawn(command: string, args?: string[], options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Array<'pipe' | 'ignore' | 'inherit'>;
    shell?: boolean;
    windowsHide?: boolean;
  }): {
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
    stdout: { on(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): void };
    stderr: { on(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): void };
    stdin: {
      on(event: 'error', listener: (error: Error) => void): void;
      write(data: string, callback?: (error?: Error | null) => void): void;
      end(): void;
    };
    kill(): void;
    pid?: number;
  };
  export function spawnSync(command: string, args?: string[], options?: {
    windowsHide?: boolean;
    encoding?: string;
    timeout?: number;
  }): { error?: Error; status: number | null; stdout?: string; stderr?: string };
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(value: string): { digest(encoding: 'hex'): string };
    digest(encoding: 'hex'): string;
  };
}

declare module 'node:child_process' {
  export { execFile, spawn, spawnSync } from 'child_process';
}

declare module 'node:readline' {
  export function createInterface(options: { input: unknown }): {
    on(event: 'line', listener: (line: string) => void): void;
    close(): void;
  };
}
