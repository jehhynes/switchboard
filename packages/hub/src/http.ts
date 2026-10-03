import { request } from 'node:http';

export interface Reply {
  status: number;
  body: string;
}

/** One loopback request. Null when nothing answered in time. */
export function call(port: number, method: 'GET' | 'POST', path: string, token: string | null, timeoutMs = 2000, body?: unknown): Promise<Reply | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const outbound = request({ host: '127.0.0.1', port, method, path, headers, timeout: timeoutMs }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('error', () => resolve(null));
    });

    outbound.on('timeout', () => outbound.destroy());
    outbound.on('error', () => resolve(null));
    outbound.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
