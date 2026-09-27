import { ApiError } from './api';

interface MessageItem {
  message: string;
}

function isMessageItem(x: unknown): x is MessageItem {
  return typeof x === 'object' && x !== null && typeof (x as { message?: unknown }).message === 'string';
}

/** Pulls up to 5 `.message` strings out of an array, or null if it isn't one (or has none). */
function messagesFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const messages = value.filter(isMessageItem).map((x) => x.message);
  return messages.length > 0 ? messages.slice(0, 5) : null;
}

/**
 * Turns any thrown value into Thai toast text. For an `ApiError`, this is the API's own message,
 * followed by up to 5 detail messages (one per line, "• " prefixed) pulled from `details.errors`,
 * `details.warnings`, `details.issues` (whichever is present, first match wins), or — for Fastify's
 * own validation errors, where `details` itself is the array — from `details` directly. Any other
 * `Error` contributes just its message; anything else falls back to `fallback`.
 */
export function describeError(e: unknown, fallback = 'ทำรายการไม่สำเร็จ'): string {
  if (e instanceof ApiError) {
    const lines = [e.message];
    const details = e.details;
    let extra: string[] | null = null;
    if (Array.isArray(details)) {
      extra = messagesFrom(details);
    } else if (details && typeof details === 'object') {
      const d = details as Record<string, unknown>;
      extra = messagesFrom(d.errors) ?? messagesFrom(d.warnings) ?? messagesFrom(d.issues);
    }
    if (extra) lines.push(...extra.map((m) => `• ${m}`));
    return lines.join('\n');
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
