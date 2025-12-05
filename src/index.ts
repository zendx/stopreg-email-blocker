/* StopReg client for Node.js/TypeScript */

export interface StopregClientOptions {
  apiToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: {
    retries?: number;
    factor?: number;
    minTimeoutMs?: number;
    maxTimeoutMs?: number;
  };
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
    maxSize?: number;
  };
  whitelistDomains?: string[];
  userAgent?: string;
}

export interface StopregApiResponse {
  message: string;
  data?: {
    email?: string;
    domain?: string;
    isDisposable?: boolean;
  };
  description?: string;
  [key: string]: unknown;
}

export interface StopregCheckResult {
  email: string;
  domain: string;
  isDisposable: boolean;
  raw: StopregApiResponse;
}

class StopregError extends Error {
  status?: number;
  details?: unknown;
  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'StopregError';
    this.status = status;
    this.details = details;
  }
}

export class StopregBadRequestError extends StopregError {
  constructor(message: string, details?: unknown) {
    super(message, 400, details);
    this.name = 'StopregBadRequestError';
  }
}

export class StopregAuthError extends StopregError {
  constructor(message: string, details?: unknown) {
    super(message, 401, details);
    this.name = 'StopregAuthError';
  }
}

export class StopregRateLimitError extends StopregError {
  constructor(message: string, details?: unknown) {
    super(message, 429, details);
    this.name = 'StopregRateLimitError';
  }
}

export class StopregServerError extends StopregError {
  constructor(message: string, status: number, details?: unknown) {
    super(message, status, details);
    this.name = 'StopregServerError';
  }
}

interface CacheEntry {
  value: StopregCheckResult;
  expiresAt: number;
}

export class StopregClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: Required<NonNullable<StopregClientOptions['retry']>>;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheConfig: Required<NonNullable<StopregClientOptions['cache']>>;
  private readonly cache: Map<string, CacheEntry>;
  private readonly whitelist: Set<string>;

  constructor(options: StopregClientOptions = {}) {
    const token = options.apiToken ?? process.env.STOPREG_API_TOKEN;
    if (!token) {
      throw new StopregAuthError('STOPREG_API_TOKEN is required');
    }

    this.apiToken = token;
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? 'https://api.stopreg.com';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retry = {
      retries: options.retry?.retries ?? 2,
      factor: options.retry?.factor ?? 2,
      minTimeoutMs: options.retry?.minTimeoutMs ?? 300,
      maxTimeoutMs: options.retry?.maxTimeoutMs ?? 3_000
    };
    this.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
    if (options.userAgent) {
      this.headers['User-Agent'] = options.userAgent;
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new StopregError('Fetch implementation is not available. Provide one via options.fetch.');
    }
    this.cacheConfig = {
      enabled: options.cache?.enabled ?? true,
      ttlMs: options.cache?.ttlMs ?? 5 * 60 * 1000,
      maxSize: options.cache?.maxSize ?? 500
    };
    this.cache = new Map();
    this.whitelist = new Set((options.whitelistDomains ?? []).map((d) => d.toLowerCase()));
  }

  async check(email: string): Promise<StopregCheckResult> {
    const normalizedEmail = email?.trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new StopregBadRequestError('A valid email address is required');
    }

    const domain = this.extractDomain(normalizedEmail);
    if (this.isWhitelisted(domain)) {
      return {
        email: normalizedEmail,
        domain,
        isDisposable: false,
        raw: { message: 'success', data: { email: normalizedEmail, domain, isDisposable: false } }
      };
    }

    const cached = this.getFromCache(domain);
    if (cached) return cached;

    const url = `${this.baseUrl}/api/v1/check/${encodeURIComponent(this.apiToken)}?email=${encodeURIComponent(normalizedEmail)}`;
    const response = await this.fetchWithRetry(url, { method: 'GET', headers: this.headers });

    const parsed = await this.safeJson(response);
    if (response.status >= 400) {
      this.throwMappedError(response.status, parsed);
    }

    const result: StopregCheckResult = {
      email: (parsed.data?.email as string) || normalizedEmail,
      domain: (parsed.data?.domain as string) || domain,
      isDisposable: Boolean(parsed.data?.isDisposable),
      raw: parsed
    };

    this.saveToCache(domain, result);
    return result;
  }

  async isDisposable(email: string): Promise<boolean> {
    const result = await this.check(email);
    return result.isDisposable;
  }

  private extractDomain(email: string): string {
    return email.split('@').pop()!.toLowerCase();
  }

  private isWhitelisted(domain: string): boolean {
    return this.whitelist.has(domain);
  }

  private getFromCache(domain: string): StopregCheckResult | undefined {
    if (!this.cacheConfig.enabled) return undefined;
    const entry = this.cache.get(domain);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(domain);
      return undefined;
    }
    return entry.value;
  }

  private saveToCache(domain: string, value: StopregCheckResult) {
    if (!this.cacheConfig.enabled) return;
    if (this.cache.size >= this.cacheConfig.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(domain, { value, expiresAt: Date.now() + this.cacheConfig.ttlMs });
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const { retries, factor, minTimeoutMs, maxTimeoutMs } = this.retry;
    let attempt = 0;

    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok || attempt >= retries || !this.shouldRetry(response.status)) {
          return response;
        }
      } catch (error) {
        if (attempt >= retries) {
          throw new StopregError('Network error', undefined, error);
        }
      }

      attempt += 1;
      const delay = Math.min(maxTimeoutMs, minTimeoutMs * Math.pow(factor, attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async safeJson(response: Response): Promise<StopregApiResponse> {
    try {
      return (await response.json()) as StopregApiResponse;
    } catch (error) {
      throw new StopregError('Failed to parse response JSON', response.status, error);
    }
  }

  private throwMappedError(status: number, body: StopregApiResponse): never {
    const description = body.description || body.message || 'Request failed';
    if (status === 400) throw new StopregBadRequestError(description, body);
    if (status === 401) throw new StopregAuthError(description, body);
    if (status === 429) throw new StopregRateLimitError(description, body);
    if (status >= 500) throw new StopregServerError(description, status, body);
    throw new StopregError(description, status, body);
  }
}

export default StopregClient;
