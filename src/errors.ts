export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
