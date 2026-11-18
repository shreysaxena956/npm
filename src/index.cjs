'use strict';

/**
 * Error thrown when an operation times out.
 */
class TimeoutError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Error thrown to immediately abort any further retry attempts.
 */
class BailError extends Error {
  /**
   * @param {string | Error} messageOrError
   */
  constructor(messageOrError) {
    const isError = messageOrError instanceof Error;
    super(isError ? messageOrError.message : String(messageOrError));
    this.name = 'BailError';
    this.bail = true;
    if (isError) {
      this.cause = messageOrError;
      this.originalError = messageOrError;
    }
  }
}

/**
 * Error thrown when all retry attempts are exhausted.
 */
class RetryError extends Error {
  /**
   * @param {string} message
   * @param {Error[]} errors
   * @param {number} attempts
   */
  constructor(message, errors = [], attempts = 0) {
    const lastError = errors[errors.length - 1];
    super(message, { cause: lastError });
    this.name = 'RetryError';
    this.errors = errors;
    this.attempts = attempts;
  }
}

/**
 * Create a BailError to instantly halt retry attempts.
 *
 * @param {string | Error} messageOrError
 * @returns {BailError}
 */
function bail(messageOrError) {
  return new BailError(messageOrError);
}

/**
 * Sleep helper that respects an AbortSignal.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new Error('This operation was aborted'));
    }
    if (ms <= 0) {
      return resolve();
    }

    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('This operation was aborted'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps a promise in a timeout.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Calculates backoff delay with optional jitter.
 *
 * @param {number} attempt
 * @param {number} baseDelay
 * @param {number} factor
 * @param {number} maxDelay
 * @param {boolean | 'full' | 'half'} jitter
 * @returns {number}
 */
function calculateDelay(attempt, baseDelay, factor, maxDelay, jitter) {
  const calculated = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);

  if (!jitter) {
    return Math.round(calculated);
  }

  if (jitter === 'half') {
    const half = calculated / 2;
    return Math.round(half + Math.random() * half);
  }

  // Full jitter: uniform distribution between 0 and calculated delay
  return Math.round(Math.random() * calculated);
}

/**
 * @typedef {Object} RetryOptions
 * @property {number} [retries=3] Maximum number of retry attempts after the initial run.
 * @property {number} [delay=1000] Initial delay in milliseconds before the first retry.
 * @property {number} [factor=2] Exponential backoff multiplier.
 * @property {number} [maxDelay=30000] Upper cap on backoff delay in milliseconds.
 * @property {boolean | 'full' | 'half'} [jitter=true] Jitter strategy to prevent thundering herd.
 * @property {number} [timeout] Timeout per attempt in milliseconds.
 * @property {AbortSignal} [signal] AbortSignal to cancel retries externally.
 * @property {(error: Error, attempt: number) => boolean | Promise<boolean>} [retryIf] Filter predicate deciding if an error should trigger a retry.
 * @property {(info: { error: Error, attempt: number, delay: number, maxRetries: number }) => void} [onRetry] Callback fired before waiting for the next attempt.
 */

/**
 * Retries an asynchronous function with exponential backoff and jitter.
 *
 * @template T
 * @param {(attempt: number) => Promise<T> | T} fn The function to execute.
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError(`Expected "fn" to be a function, got ${typeof fn}`);
  }

  const {
    retries = 3,
    delay = 1000,
    factor = 2,
    maxDelay = 30000,
    jitter = true,
    timeout,
    signal,
    retryIf,
    onRetry
  } = options;

  if (typeof retries !== 'number' || retries < 0 || !Number.isInteger(retries)) {
    throw new RangeError('Option "retries" must be a non-negative integer');
  }
  if (typeof delay !== 'number' || delay < 0 || Number.isNaN(delay)) {
    throw new RangeError('Option "delay" must be a non-negative number');
  }
  if (typeof factor !== 'number' || factor < 1 || Number.isNaN(factor)) {
    throw new RangeError('Option "factor" must be a number >= 1');
  }
  if (typeof maxDelay !== 'number' || maxDelay < delay || Number.isNaN(maxDelay)) {
    throw new RangeError('Option "maxDelay" must be a number >= "delay"');
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0 || Number.isNaN(timeout))) {
    throw new RangeError('Option "timeout" must be a positive number');
  }

  const errors = [];
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('This operation was aborted');
    }

    try {
      const promise = Promise.resolve().then(() => fn(attempt));
      return await (timeout ? withTimeout(promise, timeout) : promise);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);

      // Bail out immediately if explicitly requested
      if (error instanceof BailError || error.bail === true) {
        throw error.originalError || error;
      }

      // Propagate abort signals directly
      if (signal?.aborted && error === signal.reason) {
        throw error;
      }

      // Predicate check
      if (retryIf) {
        const shouldRetry = await retryIf(error, attempt);
        if (!shouldRetry) {
          throw error;
        }
      }

      // If we've reached the final attempt, throw the aggregate RetryError
      if (attempt >= maxAttempts) {
        throw new RetryError(
          `Operation failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${error.message}`,
          errors,
          attempt
        );
      }

      const waitTime = calculateDelay(attempt, delay, factor, maxDelay, jitter);

      if (typeof onRetry === 'function') {
        try {
          onRetry({
            error,
            attempt,
            delay: waitTime,
            maxRetries: retries
          });
        } catch {
          // Prevent onRetry callback errors from silently swallowing the original error
        }
      }

      await sleep(waitTime, signal);
    }
  }
}

retry.bail = bail;
retry.RetryError = RetryError;
retry.TimeoutError = TimeoutError;
retry.BailError = BailError;

module.exports = retry;
module.exports.retry = retry;
module.exports.bail = bail;
module.exports.RetryError = RetryError;
module.exports.TimeoutError = TimeoutError;
module.exports.BailError = BailError;
module.exports.default = retry;
