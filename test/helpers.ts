import assert from 'node:assert/strict';

export function expectDefined<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, 'Expected value to be present');
  return value;
}
