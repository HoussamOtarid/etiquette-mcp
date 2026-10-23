/**
 * EAN/GTIN helpers. Accepts GTIN-8, UPC-A (12), EAN-13 and GTIN-14; returns a canonical EAN-13 when possible.
 */

function checkDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  const expected = Number(digits.at(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === expected;
}

/** Returns the canonical barcode (UPC-A is padded to EAN-13), or null if the input is not a valid GTIN. */
export function normalizeEan(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (!checkDigitValid(digits)) return null;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 14 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Store-internal codes that are not real product barcodes and must never be used to match products across sources:
 * La Belle Vie uses `9000000<id>` for loose produce; EAN prefixes 02 and 20–29 are "restricted circulation" codes
 * (weighed items, in-store labels).
 */
export function isInternalCode(ean: string): boolean {
  return ean.startsWith("9000000") || /^0?2\d/.test(ean.length === 13 ? ean : ean.padStart(13, "0"));
}

/** A barcode usable as a cross-source join key. */
export function usableEan(input: string | number | null | undefined): string | null {
  const ean = normalizeEan(input);
  return ean && !isInternalCode(ean) ? ean : null;
}

/** True when a free-text query is just a barcode (digits, optional spaces/dashes). */
export function looksLikeBarcode(query: string): boolean {
  return /^[\d\s-]{8,18}$/.test(query.trim()) && normalizeEan(query) !== null;
}
