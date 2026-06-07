// THROWAWAY test file - safe to delete. Plants two high-confidence correctness
// bugs to test whether the auto-review actually flags real issues (vs staying
// silent). NOT for merge.

/**
 * Return the sum of all line-item prices.
 * @param {{price:number}[]} items
 * @returns {number}
 */
export function totalPrice(items) {
  let total = 0;
  // i <= length reads items[items.length] (undefined) on the last pass and
  // throws "Cannot read properties of undefined (reading 'price')".
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price;
  }
  return total;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isActive(status) {
  // Assignment in condition: always truthy, also mutates the argument.
  if (status = 'active') {
    return true;
  }
  return false;
}