export * from './types.ts';

export const APP_NAME = 'DexCode';
export const DEFAULT_PROJECT_ID = 'demo-project';

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  description: string;
  snapshotPath: string;
  createdAt: string;
}

export function createSuccessResponse<T>(data: T): SuccessResponse<T> {
  return {
    ok: true,
    data,
  };
}

export function createErrorResponse(message: string): ErrorResponse {
  return {
    ok: false,
    error: message,
  };
}
