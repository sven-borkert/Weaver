import { PASSWORD_MIN_LENGTH } from "@weaver/core/services/userSchemas";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * Generates a random URL-safe password using the Web Crypto API. Used by the
 * admin create-user and reset-password dialogs' "Generate" button.
 */
export function generatePassword(length: number): string {
  if (length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `Password length must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let password = "";
  for (const byte of bytes) {
    password += ALPHABET[byte % ALPHABET.length];
  }
  return password;
}
