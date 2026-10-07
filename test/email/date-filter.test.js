const {
  normalizeDateInput,
  buildDateFilter,
  combineFilterConditions,
} = require('../../email/date-filter');

describe('normalizeDateInput', () => {
  test('normalizes date-only receivedAfter to midnight UTC', () => {
    expect(normalizeDateInput('2024-01-01', 'receivedAfter')).toBe('2024-01-01T00:00:00.000Z');
  });

  test('normalizes date-only receivedBefore to end-of-day UTC', () => {
    expect(normalizeDateInput('2024-06-30', 'receivedBefore')).toBe('2024-06-30T23:59:59.999Z');
  });

  test('converts offset input to UTC Z literal', () => {
    expect(normalizeDateInput('2024-01-01T14:30:00+02:00', 'receivedAfter')).toBe(
      '2024-01-01T12:30:00.000Z'
    );
  });

  test('accepts full ISO 8601 with Z suffix', () => {
    expect(normalizeDateInput('2024-01-01T14:30:00Z', 'receivedAfter')).toBe(
      '2024-01-01T14:30:00.000Z'
    );
  });

  test('throws naming the parameter on garbage input', () => {
    expect(() => normalizeDateInput('not-a-date', 'receivedAfter')).toThrow(
      /Invalid receivedAfter: "not-a-date"/
    );
  });

  test('throws naming the parameter on invalid calendar date', () => {
    expect(() => normalizeDateInput('2024-13-45', 'receivedBefore')).toThrow(
      /Invalid receivedBefore/
    );
  });

  test('throws when input lacks the ISO date shape', () => {
    expect(() => normalizeDateInput('January 1st', 'receivedAfter')).toThrow(
      /Invalid receivedAfter/
    );
  });
});

describe('buildDateFilter', () => {
  test('returns null when no bounds provided', () => {
    expect(buildDateFilter({})).toBeNull();
    expect(buildDateFilter()).toBeNull();
  });

  test('emits single ge predicate for receivedAfter only', () => {
    expect(buildDateFilter({ receivedAfter: '2024-01-01' })).toBe(
      'receivedDateTime ge 2024-01-01T00:00:00.000Z'
    );
  });

  test('emits single le predicate for receivedBefore only', () => {
    expect(buildDateFilter({ receivedBefore: '2024-06-30' })).toBe(
      'receivedDateTime le 2024-06-30T23:59:59.999Z'
    );
  });

  test('emits both bounds joined with and, unquoted', () => {
    expect(
      buildDateFilter({ receivedAfter: '2024-01-01', receivedBefore: '2024-01-31T14:30:00Z' })
    ).toBe(
      'receivedDateTime ge 2024-01-01T00:00:00.000Z and receivedDateTime le 2024-01-31T14:30:00.000Z'
    );
  });

  test('propagates validation errors naming the offending parameter', () => {
    expect(() => buildDateFilter({ receivedBefore: 'not-a-date' })).toThrow(
      /Invalid receivedBefore/
    );
  });
});

describe('combineFilterConditions', () => {
  test('places date conditions before other conditions', () => {
    expect(
      combineFilterConditions('receivedDateTime ge 2024-01-01T00:00:00.000Z', 'isRead eq false')
    ).toBe('receivedDateTime ge 2024-01-01T00:00:00.000Z and isRead eq false');
  });

  test('returns only date conditions when others absent', () => {
    expect(combineFilterConditions('receivedDateTime le 2024-06-30T23:59:59.999Z')).toBe(
      'receivedDateTime le 2024-06-30T23:59:59.999Z'
    );
  });

  test('returns other conditions alone when no dates', () => {
    expect(combineFilterConditions(null, 'hasAttachments eq true')).toBe('hasAttachments eq true');
  });

  test('returns null when nothing to combine', () => {
    expect(combineFilterConditions(null, null)).toBeNull();
  });

  test('accepts arrays and skips falsy entries', () => {
    expect(
      combineFilterConditions(
        ['receivedDateTime ge 2024-01-01T00:00:00.000Z'],
        [null, 'isRead eq false']
      )
    ).toBe('receivedDateTime ge 2024-01-01T00:00:00.000Z and isRead eq false');
  });
});
