export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parser (WHATWG field rules; comments ignored). */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let id: string | null = null;
  let event = 'message';
  let data: string[] = [];
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.search(/\r\n|\n|\r/);
      if (nl < 0) break;
      // A trailing lone '\r' may be the first half of '\r\n' — wait for the next chunk.
      if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
      const width = buffer.startsWith('\r\n', nl) ? 2 : 1;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + width);
      if (line === '') {
        if (data.length > 0) onMessage({ id, event, data: data.join('\n') });
        event = 'message';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
    }
  };
}

export function formatSse(message: { id?: string | number; event?: string; data: string }): string {
  let out = '';
  if (message.id !== undefined) out += `id: ${message.id}\n`;
  if (message.event !== undefined) out += `event: ${message.event}\n`;
  for (const line of message.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}
