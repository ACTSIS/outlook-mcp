/**
 * Date filter builder for email tools.
 *
 * Compiles receivedAfter/receivedBefore inputs into a Microsoft Graph $filter
 * predicate on receivedDateTime. Emits unquoted, UTC Z-normalized literals and
 * places date predicates FIRST when combining with other conditions (Graph
 * InefficientFilter rules require orderby properties to appear first in $filter).
 */
const RECEIVED_FIELD = 'receivedDateTime';

/**
 * Normalizes a date input to a UTC ISO 8601 string.
 *
 * Date-only inputs get inclusive edge normalization: "received after" starts
 * at midnight (T00:00:00.000Z) and "received before" ends at the last
 * millisecond of the day (T23:59:59.999Z). Offsets are converted to UTC "Z".
 *
 * @param {string} value - Date input (YYYY-MM-DD or full ISO 8601)
 * @param {string} paramName - Parameter name to report in errors
 * @returns {string} UTC ISO 8601 literal with trailing Z
 * @throws {Error} When the input is not a valid ISO 8601 date
 */
function normalizeDateInput(value, paramName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    throw new Error(
      `Invalid ${paramName}: "${value}" is not a valid ISO 8601 date (e.g. 2024-01-31 or 2024-01-31T14:30:00Z)`
    );
  }

  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid ${paramName}: "${value}" is not a valid ISO 8601 date (e.g. 2024-01-31 or 2024-01-31T14:30:00Z)`
    );
  }

  let normalized = date.toISOString();

  // Date-only inputs need an explicit edge: midnight for "after" bounds,
  // end-of-day for "before" bounds so the edge day is included.
  if (value.trim().length === 10) {
    const edge = paramName.toLowerCase().includes('before') ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    normalized = `${value.trim()}${edge}`;
  }

  return normalized;
}

/**
 * Builds a Graph $filter predicate from date bounds.
 *
 * @param {object} params - Date bounds
 * @param {string} [params.receivedAfter] - Inclusive lower bound (ISO 8601)
 * @param {string} [params.receivedBefore] - Inclusive upper bound (ISO 8601)
 * @returns {string|null} The date predicate, or null when no bounds given
 * @throws {Error} When a bound is present but not a valid ISO 8601 date
 */
function buildDateFilter({ receivedAfter, receivedBefore } = {}) {
  const dateConditions = [];

  if (receivedAfter !== undefined) {
    const normalized = normalizeDateInput(receivedAfter, 'receivedAfter');
    dateConditions.push(`${RECEIVED_FIELD} ge ${normalized}`);
  }

  if (receivedBefore !== undefined) {
    const normalized = normalizeDateInput(receivedBefore, 'receivedBefore');
    dateConditions.push(`${RECEIVED_FIELD} le ${normalized}`);
  }

  if (dateConditions.length === 0) {
    return null;
  }

  return dateConditions.join(' and ');
}

/**
 * Combines date conditions (FIRST, per InefficientFilter ordering) with other
 * filter predicates using "and".
 *
 * @param {string|null|Array<string>} dateConditions - Date predicate(s)
 * @param {string|null|Array<string>} [otherConditions] - Non-date predicate(s)
 * @returns {string|null} The combined $filter value, or null when nothing to combine
 */
function combineFilterConditions(dateConditions, otherConditions) {
  const toArray = (value) => {
    if (value === null || value === undefined) {
      return [];
    }
    return Array.isArray(value) ? value.filter(Boolean) : [value];
  };

  const combined = [...toArray(dateConditions), ...toArray(otherConditions)].filter(Boolean);

  if (combined.length === 0) {
    return null;
  }

  return combined.join(' and ');
}

module.exports = {
  normalizeDateInput,
  buildDateFilter,
  combineFilterConditions,
};
