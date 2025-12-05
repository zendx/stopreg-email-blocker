import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  StopregClient,
  StopregAuthError,
  StopregBadRequestError,
  StopregRateLimitError
} from '../src/index';

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const errorResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('StopregClient', () => {
  const token = 'test-token';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('throws when api token is missing', () => {
    expect(() => new StopregClient({ fetch: fetchMock, cache: { enabled: false } })).toThrow(StopregAuthError);
  });

  it('returns data on success', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        message: 'success',
        data: { email: 'user@example.com', domain: 'example.com', isDisposable: false }
      })
    );

    const client = new StopregClient({ apiToken: token, fetch: fetchMock, cache: { enabled: false } });
    const result = await client.check('user@example.com');

    expect(result.isDisposable).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stopreg.com/api/v1/check/test-token?email=user%40example.com',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('short-circuits whitelisted domains', async () => {
    const client = new StopregClient({
      apiToken: token,
      fetch: fetchMock,
      cache: { enabled: false },
      whitelistDomains: ['example.com']
    });

    const result = await client.check('user@example.com');
    expect(result.isDisposable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches results by domain', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        message: 'success',
        data: { email: 'first@example.com', domain: 'example.com', isDisposable: true }
      })
    );

    const client = new StopregClient({ apiToken: token, fetch: fetchMock });

    const first = await client.check('first@example.com');
    const second = await client.check('second@example.com');

    expect(first.isDisposable).toBe(true);
    expect(second.isDisposable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable status and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(500, { message: 'error' }))
      .mockResolvedValueOnce(okResponse({ message: 'success', data: { isDisposable: false } }));

    const client = new StopregClient({
      apiToken: token,
      fetch: fetchMock,
      cache: { enabled: false },
      retry: { retries: 1, minTimeoutMs: 1, maxTimeoutMs: 2, factor: 1 }
    });

    const result = await client.check('user@example.com');
    expect(result.isDisposable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws mapped errors', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(429, { message: 'error', description: 'Rate limited' })
    );

    const client = new StopregClient({
      apiToken: token,
      fetch: fetchMock,
      cache: { enabled: false },
      retry: { retries: 0 }
    });

    await expect(client.check('user@example.com')).rejects.toBeInstanceOf(StopregRateLimitError);
  });

  it('throws on invalid email', async () => {
    const client = new StopregClient({ apiToken: token, fetch: fetchMock, cache: { enabled: false } });
    await expect(client.check('')).rejects.toBeInstanceOf(StopregBadRequestError);
  });
});
