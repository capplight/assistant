/**
 * Server-sent events over a fetch Response (text/event-stream, WHATWG framing: `event:` / `data:` /
 * blank line). React Native's built-in fetch has no streaming body, so the app opens streams with
 * `expo/fetch` (3-engineering §2.1), whose `response.body` is a ReadableStream on iOS and Android.
 * Without a body stream (an older runtime, a test double) it falls back to reading the whole text.
 */

/** `id`: the SSE `id:` field of this message (null when the server sent none). */
export type SseMessage = { event: string; data: string; id: string | null };

/** The stream stopped before the server said it was finished (no bytes for `idleMs`, or cut off). */
export class StreamDroppedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StreamDroppedError';
  }
}

type Reader = { read: () => Promise<{ done: boolean; value?: Uint8Array | string }>; cancel?: () => Promise<void> };

function readerOf(res: Response): Reader | null {
  const body = (res as unknown as { body?: { getReader?: () => Reader } | null }).body;
  return body && typeof body.getReader === 'function' ? body.getReader() : null;
}

/** Splits text into SSE messages; keeps an unfinished tail for the next chunk. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sep);
      if (line === '') {
        // The last event id carries over to later events (WHATWG), like a browser's EventSource.
        if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive ping
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
    }
    return out;
  }

  /** End of stream: a last message without its blank line still counts. */
  end(): SseMessage[] {
    const out = this.push('\n\n');
    this.buf = '';
    return out;
  }
}

/**
 * Reads the stream to its end, calling `onMessage` for each message as it arrives.
 * `idleMs`: no bytes for this long → StreamDroppedError (a dead connection on mobile often just
 * goes quiet). Any read failure → StreamDroppedError.
 */
export async function readSse(
  res: Response,
  onMessage: (m: SseMessage) => void,
  o: { idleMs: number; signal?: AbortSignal },
): Promise<void> {
  const parser = new SseParser();
  const reader = readerOf(res);
  if (!reader) {
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new StreamDroppedError(e instanceof Error ? e.message : 'read_failed');
    }
    for (const m of [...parser.push(text), ...parser.end()]) onMessage(m);
    return;
  }
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  for (;;) {
    if (o.signal?.aborted) {
      void reader.cancel?.().catch(() => undefined);
      throw new StreamDroppedError('aborted');
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StreamDroppedError('idle')), o.idleMs);
    });
    let chunk: { done: boolean; value?: Uint8Array | string };
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (e) {
      void reader.cancel?.().catch(() => undefined);
      throw e instanceof StreamDroppedError ? e : new StreamDroppedError(e instanceof Error ? e.message : 'read_failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (chunk.done) break;
    const v = chunk.value;
    const text = typeof v === 'string' ? v : v && decoder ? decoder.decode(v, { stream: true }) : '';
    for (const m of parser.push(text)) onMessage(m);
  }
  if (decoder) for (const m of parser.push(decoder.decode())) onMessage(m);
  for (const m of parser.end()) onMessage(m);
}
