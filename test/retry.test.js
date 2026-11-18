import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { retry, bail, RetryError, TimeoutError, BailError } from '../src/index.js';

const require = createRequire(import.meta.url);
const cjsModule = require('../src/index.cjs');

test('resolves immediately when first attempt succeeds', async () => {
  let calls = 0;
  const result = await retry(async (attempt) => {
    calls++;
    return `success on ${attempt}`;
  });

  assert.equal(result, 'success on 1');
  assert.equal(calls, 1);
});

test('retries on failure until success', async () => {
  let calls = 0;
  const result = await retry(
    async (attempt) => {
      calls++;
      if (calls < 3) {
        throw new Error(`flaky error ${calls}`);
      }
      return 'recovered';
    },
    { retries: 3, delay: 5, jitter: false }
  );

  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('throws RetryError when retries are exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await retry(
        async () => {
          calls++;
          throw new Error('persistent failure');
        },
        { retries: 2, delay: 5, jitter: false }
      );
    },
    (err) => {
      assert(err instanceof RetryError);
      assert.equal(err.name, 'RetryError');
      assert.equal(err.attempts, 3);
      assert.equal(err.errors.length, 3);
      assert.match(err.message, /Operation failed after 3 attempts/);
      assert.equal(err.cause?.message, 'persistent failure');
      return true;
    }
  );

  assert.equal(calls, 3);
});

test('validates input arguments strictly', async () => {
  await assert.rejects(
    () => retry(null),
    { name: 'TypeError', message: 'Expected "fn" to be a function, got object' }
  );

  await assert.rejects(
    () => retry(() => {}, { retries: -1 }),
    { name: 'RangeError', message: 'Option "retries" must be a non-negative integer' }
  );

  await assert.rejects(
    () => retry(() => {}, { delay: -10 }),
    { name: 'RangeError', message: 'Option "delay" must be a non-negative number' }
  );

  await assert.rejects(
    () => retry(() => {}, { factor: 0.5 }),
    { name: 'RangeError', message: 'Option "factor" must be a number >= 1' }
  );

  await assert.rejects(
    () => retry(() => {}, { delay: 1000, maxDelay: 500 }),
    { name: 'RangeError', message: 'Option "maxDelay" must be a number >= "delay"' }
  );

  await assert.rejects(
    () => retry(() => {}, { timeout: -5 }),
    { name: 'RangeError', message: 'Option "timeout" must be a positive number' }
  );
});

test('halts execution when bail is invoked', async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await retry(
        async () => {
          calls++;
          throw bail(new Error('fatal error - do not retry'));
        },
        { retries: 5, delay: 5 }
      );
    },
    (err) => {
      assert.equal(err.message, 'fatal error - do not retry');
      assert.notEqual(err.name, 'RetryError');
      return true;
    }
  );

  assert.equal(calls, 1);
});

test('respects retryIf conditional predicate', async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await retry(
        async () => {
          calls++;
          const error = new Error('not found');
          error.status = 404;
          throw error;
        },
        {
          retries: 3,
          delay: 5,
          retryIf: (err) => err.status !== 404
        }
      );
    },
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );

  assert.equal(calls, 1);
});

test('triggers onRetry callback on each failure prior to waiting', async () => {
  const events = [];
  await assert.rejects(
    () =>
      retry(
        async () => {
          throw new Error('boom');
        },
        {
          retries: 2,
          delay: 5,
          jitter: false,
          onRetry: (data) => events.push(data)
        }
      ),
    RetryError
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].delay, 5);
  assert.equal(events[1].attempt, 2);
  assert.equal(events[1].delay, 10);
});

test('aborts retrying when AbortSignal triggers during delay', async () => {
  const controller = new AbortController();
  let calls = 0;

  setTimeout(() => controller.abort(new Error('user cancelled')), 20);

  await assert.rejects(
    async () => {
      await retry(
        async () => {
          calls++;
          throw new Error('temporary fault');
        },
        { retries: 5, delay: 100, signal: controller.signal }
      );
    },
    (err) => {
      assert.equal(err.message, 'user cancelled');
      return true;
    }
  );

  assert.equal(calls, 1);
});

test('times out attempt when timeout threshold is exceeded', async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await retry(
        async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'ok';
        },
        { retries: 1, timeout: 15, delay: 5 }
      );
    },
    (err) => {
      assert(err instanceof RetryError);
      assert(err.cause instanceof TimeoutError);
      assert.match(err.cause.message, /timed out after 15ms/);
      return true;
    }
  );

  assert.equal(calls, 2);
});

test('verifies Dual CJS/ESM module compatibility', () => {
  assert.equal(typeof cjsModule, 'function');
  assert.equal(typeof cjsModule.retry, 'function');
  assert.equal(typeof cjsModule.bail, 'function');
  assert.equal(cjsModule.RetryError, RetryError);
  assert.equal(cjsModule.TimeoutError, TimeoutError);
  assert.equal(cjsModule.BailError, BailError);

  assert.equal(typeof retry, 'function');
  assert.equal(typeof bail, 'function');
});
