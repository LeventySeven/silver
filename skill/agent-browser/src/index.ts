/**
 * Public API barrel for the `uab` package. Later batches import these symbols;
 * keep the surface stable.
 */
export type { Envelope } from './core/envelope.js'
export { ok, fail, print } from './core/envelope.js'

export { ERRORS } from './core/errors.js'
export type { ErrorCode, ErrorEntry } from './core/errors.js'

export type { RefEntry, RefMap } from './perception/refmap.js'
export { parseRef, groundRef, newGeneration } from './perception/refmap.js'

export {
  openSession,
  connect,
  closeSession,
  readSidecar,
  saveRefMap,
  loadRefMap,
  sessionDir,
  sessionsRoot,
} from './core/session.js'
export type { SessionInfo, OpenOptions, Connection } from './core/session.js'
