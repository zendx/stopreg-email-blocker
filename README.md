# StopReg Email Blocker (Node/TypeScript)

Lightweight client for the StopReg email validation API. Fetches `isDisposable` for an email, with sensible defaults for retries, timeouts, and caching. Built for server-side usage only (keep your API token secret).

## Install

```bash
npm install stopreg-email-blocker
```

Requires Node.js 18+ (for built-in `fetch`).

## Quick start

```ts
import { StopregClient } from 'stopreg-email-blocker';

const client = new StopregClient({
  apiToken: process.env.STOPREG_API_TOKEN,
  whitelistDomains: ['mycompany.com'] // optional shortcut: never disposable
});

const result = await client.check('user@example.com');

if (result.isDisposable) {
  // block signup or ask for a different email
} else {
  // proceed
}
```

Or a simple boolean helper:

```ts
const isDisposable = await client.isDisposable('user@example.com');
```

## API

### `new StopregClient(options)`

Options:

- `apiToken` (string, required unless `STOPREG_API_TOKEN` env is set)
- `baseUrl` (string, default `https://api.stopreg.com`)
- `timeoutMs` (number, default `10000`)
- `retry` ({`retries`, `factor`, `minTimeoutMs`, `maxTimeoutMs`}) for 429/5xx/network
- `headers` (record) extra headers
- `userAgent` (string) to set `User-Agent`
- `fetch` (function) custom fetch for tests/older runtimes
- `cache` ({`enabled`, `ttlMs`, `maxSize`}, defaults to enabled, 5m TTL)
- `whitelistDomains` (string[]) domains that short-circuit as non-disposable

### `check(email: string)`

Returns `{ email, domain, isDisposable, raw }`. Throws on HTTP errors with typed errors:

- `StopregBadRequestError` (400)
- `StopregAuthError` (401 or missing token)
- `StopregRateLimitError` (429)
- `StopregServerError` (>=500)
- `StopregError` (network/parse/other)

### `isDisposable(email: string)`

Returns a boolean convenience wrapper over `check`.

## Publishing to GitHub Packages

Package is configured for the `@stopreg` scope and GitHub Packages registry. To publish:

```bash
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT" > ~/.npmrc  # or login interactively
npm login --registry=https://npm.pkg.github.com --scope=@stopreg   # optional if .npmrc has token
npm run build
npm publish
```

Your PAT needs `write:packages` (and `repo` if the repo is private). Update the scope/registry in `.npmrc` and `package.json` if you use a different scope.

## CLI / Integration tests

No CLI included. Add your own tiny wrapper if needed. Integration tests can be added easily by invoking `check` with a real token (`STOPREG_API_TOKEN`).

## Development

```bash
npm install
npm test    # unit tests (vitest)
npm run build
```

## Implementation notes

- Uses built-in `fetch`; supply `options.fetch` if your runtime lacks it.
- Retries only for 429/5xx and network failures, with exponential backoff.
- Simple domain-level in-memory cache to reduce repeat lookups.
- Whitelist short-circuits before any network call.

## Security

- Never expose your API token in client-side code.
- Store tokens in env vars or a secret manager.
- Rotate tokens if leaked.
