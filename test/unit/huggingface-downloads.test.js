import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../../src/index.js';

const upstream = 'https://huggingface.co/demo/model/resolve/main/model.safetensors';
const storage = 'https://cdn.example.net/model.safetensors';
const commit = '0123456789abcdef0123456789abcdef01234567';
const linkedEtag = '"model-sha256"';
const metadata = {
  'X-Repo-Commit': commit,
  'X-Linked-Etag': linkedEtag,
  'X-Linked-Size': '4'
};

/** @type {ExecutionContext} */
const executionContext = { waitUntil() {}, passThroughOnException() {} };

describe('Hugging Face file downloads', () => {
  beforeEach(() => {
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => null), put: vi.fn(async () => undefined) }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves Hub metadata on HEAD after a weight redirects to storage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === upstream && options?.redirect === 'manual') {
        return new Response(null, { status: 302, headers: { ...metadata, Location: storage } });
      }
      return new Response(null, {
        headers: { 'Content-Length': '4', Etag: '"storage-etag"' }
      });
    });

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors', {
        method: 'HEAD'
      }),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Repo-Commit')).toBe(commit);
    expect(response.headers.get('X-Linked-Etag')).toBe(linkedEtag);
    expect(response.headers.get('X-Linked-Size')).toBe('4');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      cf: { cacheTtl: -1, cacheEverything: false }
    });
  });

  it('keeps range downloads on the proxy and strips credentials before storage redirects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === upstream && options?.redirect === 'manual') {
        return new Response(null, { status: 302, headers: { ...metadata, Location: storage } });
      }
      return new Response('data', {
        status: 206,
        headers: { 'Content-Length': '4', 'Content-Range': 'bytes 0-3/4' }
      });
    });

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors', {
        headers: { Authorization: 'Bearer hf_test_token', Range: 'bytes=0-3' }
      }),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('data');
    expect(response.headers.get('X-Repo-Commit')).toBe(commit);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-3/4');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const initialHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    const storageHeaders = new Headers(fetchSpy.mock.calls[1][1]?.headers);
    expect(initialHeaders.get('Authorization')).toBe('Bearer hf_test_token');
    expect(storageHeaders.get('Authorization')).toBeNull();
    expect(storageHeaders.get('Range')).toBe('bytes=0-3');
  });

  it('preserves authentication across relative Hub redirects and metadata across the full chain', async () => {
    const cachedFile = 'https://huggingface.co/api/resolve-cache/models/demo/model/commit/file';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === upstream && options?.redirect === 'manual') {
        return new Response(null, {
          status: 307,
          headers: { ...metadata, Location: '/api/resolve-cache/models/demo/model/commit/file' }
        });
      }
      if (String(input) === cachedFile) {
        return new Response(null, { status: 302, headers: { Location: storage } });
      }
      return new Response(null, { headers: { 'Content-Length': '4' } });
    });

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors', {
        method: 'HEAD',
        headers: { Authorization: 'Bearer hf_test_token' }
      }),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.headers.get('X-Repo-Commit')).toBe(commit);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchSpy.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      'Bearer hf_test_token'
    );
    expect(new Headers(fetchSpy.mock.calls[2][1]?.headers).get('Authorization')).toBeNull();
  });

  it('stops redirect loops instead of retrying forever or returning download metadata', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { ...metadata, Location: upstream } })
      );

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors', {
        method: 'HEAD'
      }),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('X-Repo-Commit')).toBeNull();
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it('does not attach successful download metadata to a storage error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { ...metadata, Location: storage } })
      )
      .mockResolvedValueOnce(new Response('File not found', { status: 404 }));

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors'),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Repo-Commit')).toBeNull();
  });

  it('retains metadata when HEAD requires a range probe to discover the file size', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === upstream) {
        return new Response(null, { status: 302, headers: { ...metadata, Location: storage } });
      }
      if (options?.method === 'HEAD') {
        return new Response(null);
      }
      return new Response('d', {
        status: 206,
        headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/4' }
      });
    });

    const response = await worker.fetch(
      new Request('https://example.com/hf/demo/model/resolve/main/model.safetensors', {
        method: 'HEAD'
      }),
      { MAX_RETRIES: '1' },
      executionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Repo-Commit')).toBe(commit);
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(await response.text()).toBe('');
    expect(new Headers(fetchSpy.mock.calls[3][1]?.headers).get('Range')).toBe('bytes=0-0');
  });
});
