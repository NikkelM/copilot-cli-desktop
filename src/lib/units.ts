/**
 * Token counts as a reader would say them.
 *
 * A context size is the one number that distinguishes one tier from another, and 200000 is
 * harder to compare at a glance than 200k.
 */
export function tokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  return `${Math.round(count / 1000)}k`;
}

/**
 * Credits, at the precision the number deserves.
 *
 * The same rule the CLI uses: enough decimals to tell two prices apart, and no more, since
 * trailing zeroes on a large figure only make it harder to read.
 */
export function credits(amount: number): string {
  if (amount > 0 && amount < 0.01) return '<0.01';

  const decimals = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(
    amount,
  );
}

/**
 * A size on disk, in the unit that makes it a number worth reading.
 *
 * One decimal below ten and none above, so a list of them lines up and the difference
 * between two sessions is the part that stands out rather than the digits they share.
 */
export function bytes(count: number): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
