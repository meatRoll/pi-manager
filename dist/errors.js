export function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
