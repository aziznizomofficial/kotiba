// Model downloads go through Chromium's network stack first (the Windows proxy and certificate
// store — antivirus HTTPS scanning), with Node's fetch behind it only for a request Chromium's
// could not start.

import { describe, expect, it } from 'vitest';

import { downloadTransport } from '../../src/main/download-transport.js';

const ok = (body: string): typeof fetch => (async () => new Response(body)) as typeof fetch;
const refuse = (why: string): typeof fetch =>
  (async () => {
    throw new TypeError(why);
  }) as typeof fetch;

describe('downloadTransport', () => {
  it('uses the first transport when it answers', async () => {
    const response = await downloadTransport(ok('net'), ok('node'))('https://x');
    expect(await response.text()).toBe('net');
  });

  it('falls back to the second for a request the first could not start', async () => {
    const response = await downloadTransport(refuse('net::ERR_CERT_AUTHORITY_INVALID'), ok('node'))('https://x');
    expect(await response.text()).toBe('node');
  });

  it('reports the first transport\'s reason when both fail', async () => {
    await expect(downloadTransport(refuse('net::ERR_PROXY_CONNECTION_FAILED'), refuse('fetch failed'))('https://x')).rejects.toThrow(
      /ERR_PROXY_CONNECTION_FAILED/u,
    );
  });

  it('never retries an aborted request on the other transport', async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = 0;
    const second = (async () => {
      asked += 1;
      return new Response('node');
    }) as typeof fetch;
    await expect(downloadTransport(refuse('aborted'), second)('https://x', { signal: controller.signal })).rejects.toThrow(/aborted/u);
    expect(asked).toBe(0);
  });

  it('an HTTP error status is an answer, not a failure: no fallback', async () => {
    let asked = 0;
    const second = (async () => {
      asked += 1;
      return new Response('node');
    }) as typeof fetch;
    const response = await downloadTransport((async () => new Response('busy', { status: 503 })) as typeof fetch, second)('https://x');
    expect(response.status).toBe(503);
    expect(asked).toBe(0);
  });
});
