/**
 * Sanitization and validation helpers shared by every form endpoint.
 */

/** Escape HTML special characters, single quotes included. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip tags, trim, and cap length. */
export function sanitize(input: string, maxLength: number): string {
  return input.replace(/<[^>]*>/g, '').trim().slice(0, maxLength);
}

/** Format-level email validation. Deliberately permissive — deliverability is not a regex's job. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Strip CR, LF and NUL so a value cannot inject additional email headers. */
export function sanitizeEmailHeader(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}
