/** Shared wire contract only: no runtime/VS Code/DSH dependencies. */
export const EVENT_CHANNEL_VERSION = 1
export const EVENT_METHOD = 'vscode.events.event'
// Reserved for E3; E1 does NOT implement subscription RPCs.
export const EVENT_SUBSCRIBE_METHOD = 'vscode.events.subscribe'
export const EVENT_UNSUBSCRIBE_METHOD = 'vscode.events.unsubscribe'
export const SELECTION_COALESCE_MS = 50
export const EVENT_QUEUE_MAX_COUNT = 256
export const EVENT_QUEUE_MAX_BYTES = 1024 * 1024
export const EVENT_MAX_BYTES = 256 * 1024

export const EVENT_TYPES = Object.freeze([
  'documentChanged', 'documentOpened', 'documentClosed', 'documentSaved',
  'tabsChanged', 'activeEditorChanged', 'selectionChanged', 'visibleRangesChanged',
  'windowFocusChanged', 'gap', 'streamClosed',
])
export const EVENT_ENVELOPE_FIELDS = Object.freeze({
  subscriptionId: 'non-empty string (<=128 UTF-8 bytes)',
  streamEpoch: 'non-empty string (<=128 UTF-8 bytes), opaque',
  seq: 'positive safe integer',
  type: 'EVENT_TYPES member',
  observedAt: 'non-negative safe integer, diagnostic Unix milliseconds',
  payload: 'JSON object; business schema is owned by E2',
})
export const EVENT_CHANNEL_HELLO = Object.freeze({ version: EVENT_CHANNEL_VERSION })

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const identifier = (v) => typeof v === 'string' && v.trim() !== ''
  && Buffer.byteLength(v, 'utf8') <= 128
export function validEventStream(v) {
  return object(v) && identifier(v.subscriptionId) && identifier(v.streamEpoch)
    && Number.isSafeInteger(v.startSeq) && v.startSeq > 0
}
/** A field name/reason only, NEVER include the bad payload in diagnostics. */
export function eventEnvelopeError(v) {
  if (!object(v)) return 'envelope'
  if (Object.keys(v).some((key) => !Object.hasOwn(EVENT_ENVELOPE_FIELDS, key))) return 'unknown-field'
  if (!identifier(v.subscriptionId)) return 'subscriptionId'
  if (!identifier(v.streamEpoch)) return 'streamEpoch'
  if (!Number.isSafeInteger(v.seq) || v.seq < 1) return 'seq'
  if (!EVENT_TYPES.includes(v.type)) return 'type'
  if (!Number.isSafeInteger(v.observedAt) || v.observedAt < 0) return 'observedAt'
  if (!object(v.payload)) return 'payload'
  if ((v.type === 'gap' || v.type === 'streamClosed')
      && (Object.keys(v.payload).some((k) => k !== 'reason')
        || !['queue-overflow', 'event-too-large', 'invalid-event', 'seq-gap',
          'listener-failed', 'closed', 'unsubscribed', 'not-allowed', 'write-failed']
          .includes(v.payload.reason))) return 'control-payload'
  return null
}
