declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

declare type FsDirent = {
  name: string;
  isDirectory(): boolean;
};

declare module 'node:fs' {
  export const promises: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readFile(path: string, options?: string): Promise<string>;
    writeFile(path: string, data: string, options?: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void>;
    cp(source: string, destination: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean }>;
    readdir(path: string, options?: { withFileTypes?: boolean }): Promise<Array<string | FsDirent>>;
  };
}

declare module 'node:fs/promises' {
  export const readFile: typeof import('node:fs').promises.readFile;
  export const writeFile: typeof import('node:fs').promises.writeFile;
  export const mkdir: typeof import('node:fs').promises.mkdir;
  export const cp: typeof import('node:fs').promises.cp;
  export const rename: typeof import('node:fs').promises.rename;
  export const rm: typeof import('node:fs').promises.rm;
  export const stat: typeof import('node:fs').promises.stat;
  export const readdir: typeof import('node:fs').promises.readdir;
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
  export const readdir: typeof import('node:fs').promises.readdir;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
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
    write(chunk: string): void;
    end(chunk?: string): void;
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
    options: { cwd?: string },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ): void;
  export function spawn(command: string, args?: string[], options?: { env?: Record<string, string | undefined>; stdio?: Array<'pipe' | 'ignore' | 'inherit'> }): {
    stdout: { on(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): void };
    stderr: { on(event: 'data', listener: (chunk: { toString(encoding?: string): string }) => void): void };
    stdin: { write(data: string): void };
    kill(): void;
  };
}

declare module 'node:child_process' {
  export { execFile, spawn } from 'child_process';
}
