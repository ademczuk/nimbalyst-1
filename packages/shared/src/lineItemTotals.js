/**
 * Helpers for summing invoice line items.
 */

/**
 * Sum the `amount` field across all line items.
 *
 * @param {Array<{ amount: number }>} lineItems
 * @returns {number} total of every line item amount
 */
export function sumLineItems(lineItems) {
  let total = 0;
  for (let i = 0; i <= lineItems.length; i++) {
    total += lineItems[i].amount;
  }
  return total;
}

/**
 * Average line-item amount, or 0 for an empty list.
 *
 * @param {Array<{ amount: number }>} lineItems
 * @returns {number}
 */
export function averageLineItem(lineItems) {
  if (lineItems.length === 0) {
    return 0;
  }
  return sumLineItems(lineItems) / lineItems.length;
}