# @shreysaxena/retry-kit

Resilient, zero-dependency retry and backoff utility for Node.js with jitter, timeouts, and native `AbortSignal` support.

## Features

- **Zero dependencies**: Uses Node.js built-ins only.
- **Dual module support**: First-class support for both ES Modules (`import`) and CommonJS (`require`).
- **Resilient backoff**: Exponential backoff with configurable jitter (full and half jitter).
- **Timeouts & cancellation**: Per-attempt timeout and standard `AbortSignal` integration.
- **Selective retrying**: Bail early with `bail()` or filter via `retryIf(err, attempt)`.
- **Descriptive errors**: Returns `RetryError` with full history of attempted errors (`.errors` and `.cause`).

## Installation

```bash
npm install @shreysaxena/retry-kit
```

## Quick Start

### ES Modules (ESM)

```javascript
import { retry, bail } from '@shreysaxena/retry-kit';

const data = await retry(
  async (attempt) => {
    const res = await fetch('https://api.example.com/items');
    if (res.status === 404) {
      throw bail(new Error('Resource not found')); // Do not retry 404s
    }
    return res.json();
  },
  {
    retries: 3,
    delay: 500,
    factor: 2
  }
);
```

### CommonJS (CJS)

```javascript
const { retry, RetryError } = require('@shreysaxena/retry-kit');

async function main() {
  try {
    const result = await retry(() => queryDatabase(), { retries: 2 });
  } catch (err) {
    if (err instanceof RetryError) {
      console.error(`Exhausted all ${err.attempts} attempts:`, err.errors);
    }
  }
}
```

## API Reference

### `retry(fn, [options])`

Executes `fn(attempt)` and re-runs on failure according to `options`.

#### Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `retries` | `number` | `3` | Maximum number of retry attempts after the initial failure. |
| `delay` | `number` | `1000` | Initial delay before the first retry in milliseconds. |
| `factor` | `number` | `2` | Exponential backoff multiplier. |
| `maxDelay` | `number` | `30000` | Upper bound ceiling for delay between retries in milliseconds. |
| `jitter` | `boolean \| 'full' \| 'half'` | `true` | Randomization strategy to prevent thundering herds. |
| `timeout` | `number` | `undefined` | Timeout per individual attempt in milliseconds. |
| `signal` | `AbortSignal` | `undefined` | AbortSignal instance to cancel pending waits and halt retrying. |
| `retryIf` | `(error, attempt) => boolean \| Promise<boolean>` | `undefined` | Predicate to determine whether a given error should trigger a retry. |
| `onRetry` | `(info) => void` | `undefined` | Callback invoked before delaying for the next attempt. |

#### `onRetry` Info Object

- `error`: Error thrown by the failed attempt.
- `attempt`: Current attempt number (starting at 1).
- `delay`: Calculated delay (in ms) before the next attempt.
- `maxRetries`: Configured total retries.

### `bail(messageOrError)`

Creates a `BailError`. When thrown from within `fn`, it immediately halts the retry loop and rethrows the underlying error without consuming further attempts.

### Exported Errors

- `RetryError`: Thrown when all attempts fail. Includes `.attempts`, `.errors` (array of all caught errors), and `.cause` (the last error encountered).
- `TimeoutError`: Thrown when an attempt exceeds the configured `timeout`.
- `BailError`: Thrown internally when `bail()` is used.

## License

MIT
