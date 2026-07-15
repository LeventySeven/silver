/**
 * Encrypted-state-at-rest for session sidecars (agent-browser parity).
 *
 * Transparent AES-256-GCM for the JSON sidecars Silver persists under
 * `~/.silver/.../` — so cookies/storage-adjacent session state is never left as
 * plaintext on disk. This mirrors the Rust fork's `native/state.rs` design
 * (AES-256-GCM, random 12-byte nonce, appended auth tag) but keyed off a
 * per-machine key file instead of a passphrase env.
 *
 * On-disk blob layout (a single `Buffer`):
 *
 *     MAGIC(4 = "SLV1") | IV(12, random per write) | ciphertext | authTag(16)
 *
 * The 4-byte magic makes migration detection deterministic: an encrypted blob
 * never begins with `{`/whitespace, so `decodeStateBuffer` can cleanly tell an
 * encrypted sidecar from a legacy plaintext-JSON one and decode either.
 *
 * KEYLESS: `node:crypto` is a Node builtin, not a model. No network, no LLM.
 */
import * as crypto from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Blob format marker + fixed field sizes for AES-256-GCM. */
const MAGIC = Buffer.from('SLV1', 'ascii')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const HEADER_LEN = MAGIC.length + IV_LEN
const MIN_BLOB_LEN = HEADER_LEN + TAG_LEN

/**
 * Per-invocation override for encryption-at-rest. `null` means "not set by a
 * flag" — fall through to the `SILVER_NO_ENCRYPT_STATE` env, then the default
 * (ON). `--no-encrypt-state` sets this to `false` via `setStateEncryption`.
 */
let encryptOverride: boolean | null = null

/**
 * Force encryption-at-rest on/off for this process (wired from the
 * `--no-encrypt-state` flag). Pass `null` to clear the override and defer to the
 * `SILVER_NO_ENCRYPT_STATE` env / default. Reads always accept BOTH plaintext
 * and ciphertext regardless of this setting, so toggling it never strands an
 * existing sidecar.
 */
export function setStateEncryption(enabled: boolean | null): void {
  encryptOverride = enabled
}

/**
 * Whether new sidecar WRITES are encrypted. Default ON; opt out with the
 * `--no-encrypt-state` flag or `SILVER_NO_ENCRYPT_STATE=1` (for debugging /
 * plaintext inspection).
 */
export function isStateEncryptionEnabled(): boolean {
  if (encryptOverride !== null) return encryptOverride
  const off = process.env.SILVER_NO_ENCRYPT_STATE
  return !(off === '1' || off === 'true')
}

/** Path to the per-machine key file (mode 0600). */
function stateKeyPath(): string {
  return path.join(os.homedir(), '.silver', '.state-key')
}

/**
 * The 32-byte AES key. From `SILVER_STATE_KEY` (base64) when set, else a
 * per-machine key file at `~/.silver/.state-key`, generated with
 * `crypto.randomBytes(32)` (mode 0600) on first use.
 */
export function getStateKey(): Buffer {
  const fromEnv = process.env.SILVER_STATE_KEY
  if (fromEnv && fromEnv.length > 0) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== KEY_LEN) {
      throw new Error('SILVER_STATE_KEY must be base64 for exactly 32 bytes')
    }
    return key
  }
  return readOrCreateKeyFile()
}

function readOrCreateKeyFile(): Buffer {
  const p = stateKeyPath()

  let existing: Buffer | undefined
  try {
    existing = readFileSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existing) {
    if (existing.length !== KEY_LEN) throw new Error('the state key file is corrupt')
    return existing
  }

  mkdirSync(path.dirname(p), { recursive: true })
  const key = crypto.randomBytes(KEY_LEN)
  try {
    // `wx` fails if a concurrent writer won the race; fall back to reading it.
    writeFileSync(p, key, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readFileSync(p)
      if (winner.length !== KEY_LEN) throw new Error('the state key file is corrupt')
      return winner
    }
    throw err
  }
  // Re-assert 0600 in case umask widened the create mode.
  try {
    chmodSync(p, 0o600)
  } catch {
    /* best effort */
  }
  return key
}

/** True when `buf` carries the encrypted-blob magic + is long enough to decrypt. */
function looksEncrypted(buf: Buffer): boolean {
  return buf.length >= MIN_BLOB_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

/** Serialize `obj` to an AES-256-GCM blob (random IV per write). */
export function encryptJson(obj: unknown): Buffer {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8')
  const key = getStateKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, iv, body, tag])
}

/**
 * Decrypt an AES-256-GCM blob produced by `encryptJson` and JSON-parse it.
 * Throws if the magic is absent, the blob is truncated, or the auth tag fails
 * (GCM integrity — tamper detection).
 */
export function decryptJson(buf: Buffer): unknown {
  if (!looksEncrypted(buf)) {
    throw new Error('not an encrypted state blob')
  }
  const key = getStateKey()
  const iv = buf.subarray(MAGIC.length, HEADER_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

/**
 * Decode a sidecar buffer transparently: an encrypted blob is decrypted, a
 * legacy plaintext-JSON sidecar is parsed as-is. This is the migration path —
 * old plaintext sidecars keep working after the feature lands.
 */
export function decodeStateBuffer(buf: Buffer): unknown {
  if (looksEncrypted(buf)) return decryptJson(buf)
  return JSON.parse(buf.toString('utf8'))
}
