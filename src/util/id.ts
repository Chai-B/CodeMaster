import { randomUUID } from 'crypto';

export function uuid(): string {
  return randomUUID();
}

export function id(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}

let counter = 0;
export function seq(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, '0')}-${randomUUID().slice(0, 4)}`;
}
