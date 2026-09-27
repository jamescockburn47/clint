/** A count is a non-negative whole number or it is not a count. Null means the figure is unavailable. */
export function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
