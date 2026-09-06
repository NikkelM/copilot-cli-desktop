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
