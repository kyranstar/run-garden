/** WebCrypto helpers: token encryption, hashing, Ed25519 verification. */

const enc = new TextEncoder();

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

async function aesKey(secretB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(secretB64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-256-GCM; output = b64url(iv || ciphertext). */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return b64urlEncode(out);
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const bytes = b64urlDecode(payload);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

/** Verify an Ed25519 signature over a canonical message. */
export async function verifyEd25519(
  publicKeyB64url: string,
  message: string,
  signatureB64url: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64urlDecode(publicKeyB64url) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64urlDecode(signatureB64url) as BufferSource,
      enc.encode(message),
    );
  } catch {
    return false;
  }
}

/** Canonical message a desktop device signs for bridge API calls. */
export function deviceSigningMessage(
  method: string,
  path: string,
  timestamp: string,
  bodySha256Hex: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodySha256Hex}`;
}
