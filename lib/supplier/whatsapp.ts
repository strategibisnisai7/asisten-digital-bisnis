/**
 * Indonesian numbers for wa.me: 0812…, +62 812…, 62812…, or 812… become 62812….
 * Anything that does not look like a phone number gives null.
 */
export function normalizeWhatsAppNumber(contact: string): string | null {
  let digits = contact.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.includes("+")) return null;
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith("8")) digits = `62${digits}`;
  return /^62\d{8,13}$/.test(digits) ? digits : null;
}

/**
 * A wa.me deep link that opens a chat with the supplier. The WhatsApp API is not
 * used and nothing is sent automatically.
 */
export function whatsappLink(number: string): string {
  return `https://wa.me/${number}`;
}
