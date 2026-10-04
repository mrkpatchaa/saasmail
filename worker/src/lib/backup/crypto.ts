/**
 * Backup encryption: AES-256-GCM with the `BACKUP_ENCRYPTION_KEY` secret (64
 * hex characters). A file is a series of frames, one per chunk written:
 * a 4-byte big-endian length, then a fresh 12-byte IV and the ciphertext
 * with its 16-byte tag. Each frame decrypts on its own, so a file can be
 * written a step at a time.
 */

/** The key, or null when backups are not encrypted. Throws on a bad key. */
export async function backupKey(
  env: CloudflareBindings,
): Promise<CryptoKey | null> {
  const hex = env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 64 hex characters");
  }
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** One frame: length, IV, ciphertext and tag. */
export async function encryptFrame(
  key: CryptoKey,
  plain: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
  const frame = new Uint8Array(4 + 12 + sealed.length);
  new DataView(frame.buffer).setUint32(0, 12 + sealed.length);
  frame.set(iv, 4);
  frame.set(sealed, 16);
  return frame;
}

/** The plaintext of a file of frames (what the restore script does). */
export async function decryptFrames(
  key: CryptoKey,
  file: Uint8Array,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let at = 0;
  while (at < file.length) {
    const length = new DataView(file.buffer, file.byteOffset + at, 4).getUint32(
      0,
    );
    const iv = file.subarray(at + 4, at + 16);
    const sealed = file.subarray(at + 16, at + 4 + length);
    chunks.push(
      new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
          key,
          sealed as Uint8Array<ArrayBuffer>,
        ),
      ),
    );
    at += 4 + length;
  }
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Hex SHA-256. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
