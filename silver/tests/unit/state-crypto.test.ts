import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import {
  decodeStateBuffer,
  decryptJson,
  encryptJson,
  getStateKey,
  isStateEncryptionEnabled,
  setStateEncryption,
} from '../../src/core/state-crypto.js'
import {
  saveRefMap,
  loadRefMap,
  sessionDir,
  setNamespace,
} from '../../src/core/session.js'
import type { RefMap } from '../../src/perception/refmap.js'

// A fixed base64 key keeps these tests hermetic: `getStateKey` resolves from
// SILVER_STATE_KEY and never touches (or creates) the per-machine key file.
const FIXED_KEY_B64 = crypto.randomBytes(32).toString('base64')
const NS = `enc-test-${process.pid}`

beforeAll(() => {
  process.env.SILVER_STATE_KEY = FIXED_KEY_B64
  delete process.env.SILVER_NO_ENCRYPT_STATE
  setNamespace(NS)
})

afterEach(() => {
  // Clear the per-process encryption override + env opt-out between cases so a
  // plaintext test never leaks into an encryption test (null = defer to default).
  setStateEncryption(null)
  delete process.env.SILVER_NO_ENCRYPT_STATE
})

afterAll(async () => {
  delete process.env.SILVER_STATE_KEY
  // The namespace root is `~/.silver/<ns>` (parent of `sessions/`).
  await fs.rm(path.dirname(path.dirname(sessionDir('x'))), {
    recursive: true,
    force: true,
  }).catch(() => {})
})

const sample = {
  cookies: [{ name: 'sid', value: 'super-secret-token', domain: '.example.com' }],
  origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
}

describe('state-crypto: encryptJson / decryptJson', () => {
  it('round-trips an object through AES-256-GCM', () => {
    const blob = encryptJson(sample)
    expect(Buffer.isBuffer(blob)).toBe(true)
    // MAGIC(4) + IV(12) + ciphertext + tag(16); ciphertext must differ from plaintext.
    expect(blob.length).toBeGreaterThan(4 + 12 + 16)
    expect(blob.includes(Buffer.from('super-secret-token'))).toBe(false)
    expect(decryptJson(blob)).toEqual(sample)
  })

  it('uses a fresh random IV per write (ciphertext is non-deterministic)', () => {
    const a = encryptJson(sample)
    const b = encryptJson(sample)
    expect(a.equals(b)).toBe(false)
    // Both still decrypt to the same plaintext.
    expect(decryptJson(a)).toEqual(sample)
    expect(decryptJson(b)).toEqual(sample)
  })

  it('rejects a tampered ciphertext via the GCM auth tag', () => {
    const blob = encryptJson(sample)
    const tampered = Buffer.from(blob)
    // Flip a bit inside the ciphertext body (past MAGIC(4)+IV(12), before tag).
    const i = 4 + 12 + 1
    tampered[i] = tampered[i] ^ 0xff
    expect(() => decryptJson(tampered)).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const blob = encryptJson(sample)
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff
    expect(() => decryptJson(tampered)).toThrow()
  })

  it('decryptJson rejects a non-encrypted (plaintext) buffer', () => {
    const plain = Buffer.from(JSON.stringify(sample), 'utf8')
    expect(() => decryptJson(plain)).toThrow()
  })
})

describe('state-crypto: decodeStateBuffer (migration)', () => {
  it('decrypts an encrypted blob', () => {
    expect(decodeStateBuffer(encryptJson(sample))).toEqual(sample)
  })

  it('reads a legacy plaintext-JSON sidecar as-is', () => {
    const legacy = Buffer.from(JSON.stringify(sample), 'utf8')
    expect(decodeStateBuffer(legacy)).toEqual(sample)
  })

  it('an encrypted blob is not itself valid JSON (detection basis)', () => {
    const blob = encryptJson(sample)
    expect(() => JSON.parse(blob.toString('utf8'))).toThrow()
  })
})

describe('state-crypto: getStateKey', () => {
  it('returns the 32-byte key decoded from SILVER_STATE_KEY', () => {
    const key = getStateKey()
    expect(key.length).toBe(32)
    expect(key.equals(Buffer.from(FIXED_KEY_B64, 'base64'))).toBe(true)
  })

  it('throws when SILVER_STATE_KEY does not decode to 32 bytes', () => {
    const prev = process.env.SILVER_STATE_KEY
    process.env.SILVER_STATE_KEY = Buffer.from('too-short').toString('base64')
    try {
      expect(() => getStateKey()).toThrow()
    } finally {
      process.env.SILVER_STATE_KEY = prev
    }
  })
})

describe('state-crypto: opt-out toggle', () => {
  it('defaults ON, honors SILVER_NO_ENCRYPT_STATE and setStateEncryption', () => {
    expect(isStateEncryptionEnabled()).toBe(true)

    process.env.SILVER_NO_ENCRYPT_STATE = '1'
    expect(isStateEncryptionEnabled()).toBe(false)
    delete process.env.SILVER_NO_ENCRYPT_STATE
    expect(isStateEncryptionEnabled()).toBe(true)

    // Flag override wins over env.
    setStateEncryption(false)
    process.env.SILVER_NO_ENCRYPT_STATE = ''
    expect(isStateEncryptionEnabled()).toBe(false)
    setStateEncryption(true)
    expect(isStateEncryptionEnabled()).toBe(true)
  })
})

describe('state-crypto: transparent session sidecars (saveRefMap/loadRefMap)', () => {
  const map: RefMap = {
    generation: 7,
    entries: {
      e1: {
        generation: 7,
        backendNodeId: 42,
        role: 'button',
        name: 'Buy',
        nth: 0,
        frameId: 'main',
      },
    },
  }

  it('encrypts refmap.json at rest by default and round-trips via loadRefMap', async () => {
    const name = 'enc-default'
    await saveRefMap(name, map)

    const raw = await fs.readFile(path.join(sessionDir(name), 'refmap.json'))
    // On-disk bytes are the encrypted blob, not plaintext JSON.
    expect(raw.subarray(0, 4).toString('ascii')).toBe('SLV1')
    expect(() => JSON.parse(raw.toString('utf8'))).toThrow()

    expect(await loadRefMap(name)).toEqual(map)
  })

  it('opt-out (SILVER_NO_ENCRYPT_STATE=1) writes plaintext JSON', async () => {
    const name = 'plain-optout'
    process.env.SILVER_NO_ENCRYPT_STATE = '1'
    await saveRefMap(name, map)

    const raw = await fs.readFile(path.join(sessionDir(name), 'refmap.json'), 'utf8')
    expect(raw.startsWith('SLV1')).toBe(false)
    expect(JSON.parse(raw)).toEqual(map)

    // Reads are transparent regardless of the opt-out flag.
    expect(await loadRefMap(name)).toEqual(map)
  })

  it('migration: a pre-existing plaintext refmap.json is still readable', async () => {
    const name = 'legacy-plain'
    const dir = sessionDir(name)
    await fs.mkdir(dir, { recursive: true })
    // Simulate a sidecar written before the feature landed.
    await fs.writeFile(path.join(dir, 'refmap.json'), JSON.stringify(map), 'utf8')

    // Encryption is ON, yet the legacy plaintext file decodes fine.
    expect(isStateEncryptionEnabled()).toBe(true)
    expect(await loadRefMap(name)).toEqual(map)
  })
})
