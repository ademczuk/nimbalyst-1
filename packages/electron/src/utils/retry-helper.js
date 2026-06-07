/**
 * Retry an async operation up to `maxAttempts` times, returning the first
 * successful result. Throws the last error if every attempt fails.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} maxAttempts
 * @returns {Promise<T>}
 */
export async function retry(fn, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw error;
}