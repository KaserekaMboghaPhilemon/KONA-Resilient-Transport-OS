/**
 * Sprint 3 – Low-Bandwidth Base45 Matrix & USSD/SMS Telephony Bridge
 *
 * Translates LocalDatabase offline_sync_queue payloads into ultra-compact
 * wire strings that fit inside a single raw GSM SMS window (160 characters)
 * or a USSD session payload, then rehydrates them back to the canonical JSON
 * contract expected by the KONA PostgreSQL backend handlers.
 *
 * Wire format  (every character is GSM 7-bit basic charset compatible):
 *
 *   K{AT}_{OID}_{DATA}
 *
 *   K      – KONA magic prefix                          (1 char)
 *   {AT}   – 2-char action type code  e.g. BL = booking_lock
 *   _      – segment separator  (NOT in Base45 alphabet; valid GSM 7-bit)
 *   {OID}  – Base45 encoding of the 16 raw UUID bytes   (always 24 chars)
 *   _      – segment separator
 *   {DATA} – Base45 encoding of the UTF-8 bytes of the minified payload JSON
 *             (abbreviated keys, essential fields only, no whitespace)
 *
 * Fixed wire overhead : 1 + 2 + 1 + 24 + 1 = 29 chars
 * Available for data  : 160 − 29 = 131 chars
 *
 * Character budget validation per action type (worst-case booking_lock):
 *   Minified JSON  ≈ 62 chars → Base45 ≈ 93 chars → total wire ≈ 122 chars ✓
 *
 * No external runtime dependencies. Pure TypeScript.
 * No UI code. No network transport code.
 */

import type { OfflineActionType } from '../db/LocalDatabase';

// ---------------------------------------------------------------------------
// Limits & wire-format constants
// ---------------------------------------------------------------------------

/** Maximum characters permitted in a single GSM SMS or USSD payload window. */
export const SMS_MAX_CHARS = 160;

/**
 * The KONA magic prefix written as the first character of every wire string.
 * Its presence is the primary integrity check in decodeSMSToAction.
 */
const WIRE_PREFIX = 'K';

/**
 * Segment separator — must NOT be present in the Base45 alphabet so that
 * a simple split() always yields exactly three parts from a valid wire string.
 * Underscore is in GSM 7-bit basic charset but absent from RFC 9285 Base45.
 */
const SEGMENT_SEP = '_';

/** Base45 of exactly 16 UUID bytes always produces exactly 24 characters. */
const UUID_COMPACT_LENGTH = 24;

/** A valid wire string always splits into exactly this many segments. */
const EXPECTED_SEGMENT_COUNT = 3;

// ---------------------------------------------------------------------------
// RFC 9285 Base45 codec
// ---------------------------------------------------------------------------

/**
 * RFC 9285 Base45 alphabet, 45 characters indexed 0–44.
 * The underscore '_' is deliberately absent from this set, making it a safe
 * segment separator in the KONA wire format.
 */
const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/**
 * Pre-built reverse lookup table: character → alphabet index.
 * Avoids repeated indexOf calls during decode and throws immediately on
 * any character not in the Base45 alphabet.
 */
const BASE45_REVERSE: Readonly<Record<string, number>> = Object.freeze(
  Array.from(BASE45_ALPHABET).reduce<Record<string, number>>((acc, ch, i) => {
    acc[ch] = i;
    return acc;
  }, {}),
);

/**
 * Encodes a Uint8Array to a Base45 string following RFC 9285 §4.
 *
 * Each pair of input bytes is treated as a 16-bit little-endian integer
 * and encoded into 3 Base45 characters.  A trailing single byte is encoded
 * into 2 Base45 characters.  All output characters belong to BASE45_ALPHABET.
 */
export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      // Little-endian 16-bit value per RFC 9285: low byte first.
      const n = bytes[i] + bytes[i + 1] * 256;
      out +=
        BASE45_ALPHABET[n % 45] +
        BASE45_ALPHABET[Math.floor(n / 45) % 45] +
        BASE45_ALPHABET[Math.floor(n / (45 * 45))];
    } else {
      // Trailing single byte encodes to 2 characters.
      const n = bytes[i];
      out += BASE45_ALPHABET[n % 45] + BASE45_ALPHABET[Math.floor(n / 45)];
    }
  }
  return out;
}

/**
 * Decodes a Base45 string back to a Uint8Array following RFC 9285 §4.
 *
 * Every group of 3 characters decodes to 2 bytes.  A trailing group of
 * exactly 2 characters decodes to 1 byte.  A trailing single character
 * is structurally invalid and causes an immediate throw.
 *
 * Throws on any character not in BASE45_ALPHABET or on value overflow.
 */
export function base45Decode(encoded: string): Uint8Array {
  const bytes: number[] = [];

  for (let i = 0; i < encoded.length; i += 3) {
    const remaining = encoded.length - i;

    if (remaining === 1) {
      throw new Error(
        `[base45Decode] Malformed Base45 string: lone character at position ${i}. ` +
          `Valid strings contain groups of 3 chars (2 bytes) or a trailing pair (1 byte).`,
      );
    }

    const c0 = BASE45_REVERSE[encoded[i]];
    const c1 = BASE45_REVERSE[encoded[i + 1]];

    if (c0 === undefined || c1 === undefined) {
      throw new Error(
        `[base45Decode] Invalid Base45 character at position ${i}: ` +
          `'${encoded[i]}' (${encoded.charCodeAt(i)}) '${encoded[i + 1]}' (${encoded.charCodeAt(i + 1)}).`,
      );
    }

    if (remaining >= 3) {
      const c2 = BASE45_REVERSE[encoded[i + 2]];
      if (c2 === undefined) {
        throw new Error(
          `[base45Decode] Invalid Base45 character at position ${i + 2}: ` +
            `'${encoded[i + 2]}' (${encoded.charCodeAt(i + 2)}).`,
        );
      }
      const n = c0 + c1 * 45 + c2 * 45 * 45;
      if (n > 65535) {
        throw new Error(
          `[base45Decode] 3-char group at position ${i} decodes to ${n}, ` +
            `which exceeds the 16-bit maximum of 65535.`,
        );
      }
      bytes.push(n % 256, Math.floor(n / 256));
    } else {
      // Trailing 2-character group decodes to exactly 1 byte.
      const n = c0 + c1 * 45;
      if (n > 255) {
        throw new Error(
          `[base45Decode] Trailing 2-char group at position ${i} decodes to ${n}, ` +
            `which exceeds the 8-bit maximum of 255.`,
        );
      }
      bytes.push(n);
    }
  }

  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// UTF-8 codec  (pure JS — no TextEncoder/TextDecoder dependency)
// ---------------------------------------------------------------------------

/**
 * Encodes a JavaScript string to its UTF-8 byte representation without
 * using TextEncoder, guaranteeing identical behaviour across React Native
 * (Hermes) and Node.js (backend parser bridge).
 */
export function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0xd800 || cp >= 0xe000) {
      bytes.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      // Surrogate pair: reconstruct the full Unicode code point.
      i++;
      const hi = cp;
      const lo = str.charCodeAt(i);
      const full = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      bytes.push(
        0xf0 | (full >> 18),
        0x80 | ((full >> 12) & 0x3f),
        0x80 | ((full >> 6) & 0x3f),
        0x80 | (full & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Decodes a UTF-8 Uint8Array back to a JavaScript string without using
 * TextDecoder, guaranteeing identical behaviour across React Native and Node.js.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp =
        ((b0 & 0x0f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f);
      i += 3;
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      i += 4;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// UUID compact codec
// ---------------------------------------------------------------------------

/** Matches standard lower- or upper-case UUIDs with dashes. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Converts a standard UUID string to its compact 24-character Base45
 * representation by encoding the 16 raw UUID bytes.
 *
 * 16 bytes = 8 pairs × 3 Base45 chars = always exactly 24 output characters,
 * saving 8 characters versus the stripped 32-hex form.
 */
function uuidToCompact(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError(
      `[uuidToCompact] Invalid UUID format: '${uuid}'. ` +
        `Expected 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.`,
    );
  }
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return base45Encode(bytes);
}

/**
 * Decodes a 24-character Base45 compact UUID back to the canonical
 * 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' lowercase format.
 */
function compactToUuid(compact: string): string {
  if (compact.length !== UUID_COMPACT_LENGTH) {
    throw new Error(
      `[compactToUuid] Expected exactly ${UUID_COMPACT_LENGTH} Base45 chars, ` +
        `got ${compact.length}.`,
    );
  }
  const bytes = base45Decode(compact);
  if (bytes.length !== 16) {
    throw new Error(
      `[compactToUuid] Base45 decoded to ${bytes.length} bytes instead of 16. ` +
        `The compact UUID segment is corrupt.`,
    );
  }
  const h = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    h.slice(12, 16) +
    '-' +
    h.slice(16, 20) +
    '-' +
    h.slice(20)
  );
}

// ---------------------------------------------------------------------------
// Action-type codec maps
// ---------------------------------------------------------------------------

/**
 * Maps each OfflineActionType to its 2-character wire code.
 * Every code must be unique and composed of uppercase letters only,
 * ensuring no collision with the Base45 alphabet or segment separator.
 */
const ACTION_ENCODE: Readonly<Record<OfflineActionType, string>> = Object.freeze({
  booking_lock: 'BL',
  booking_reversal: 'BR',
  trip_settlement: 'TS',
  order_status_update: 'OS',
  driver_location_update: 'DL',
  dispatch_offer_response: 'DO',
});

/** Reverse map: 2-char wire code → canonical OfflineActionType. */
const ACTION_DECODE: Readonly<Record<string, OfflineActionType>> = Object.freeze(
  (Object.entries(ACTION_ENCODE) as Array<[OfflineActionType, string]>).reduce<
    Record<string, OfflineActionType>
  >((acc, [full, code]) => {
    acc[code] = full;
    return acc;
  }, {}),
);

// ---------------------------------------------------------------------------
// Payload key codec maps
// ---------------------------------------------------------------------------

/**
 * Maps each canonical payload field name (as declared in SPRINT1_SCHEMA.sql
 * column names and KONA backend handler contracts) to its 2-character
 * wire abbreviation.  All abbreviations must be unique.
 */
const KEY_ENCODE: Readonly<Record<string, string>> = Object.freeze({
  currency_code: 'cc',
  fare_minor: 'fm',
  driver_share_bps: 'db',
  kona_commission_bps: 'kb',
  escrow_timeout_at: 'et',
  reversal_reason: 'rr',
  status: 'st',
  h3_cell: 'h3',
  accepted: 'ac',
  bid_amount_minor: 'ba',
});

/** Reverse map: 2-char abbreviation → canonical field name. */
const KEY_DECODE: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(KEY_ENCODE).reduce<Record<string, string>>(
    (acc, [canonical, abbrev]) => {
      acc[abbrev] = canonical;
      return acc;
    },
    {},
  ),
);

// ---------------------------------------------------------------------------
// Essential-field filter table
// ---------------------------------------------------------------------------

/**
 * Defines the exact set of payload fields that are serialised to the SMS wire
 * format for each action type.  Fields outside these lists are deliberately
 * stripped (e.g. full account UUIDs like driver_storage_wallet_account_id):
 * the backend reconstructs them from the order_id and its own state, keeping
 * the encoded payload within the 131-character data budget.
 *
 * These lists must stay in sync with the SPRINT1_SCHEMA.sql handler contracts.
 */
const ESSENTIAL_FIELDS: Readonly<Record<OfflineActionType, readonly string[]>> =
  Object.freeze({
    booking_lock: [
      'currency_code',
      'fare_minor',
      'driver_share_bps',
      'kona_commission_bps',
      'escrow_timeout_at',
    ],
    booking_reversal: ['reversal_reason'],
    trip_settlement: ['fare_minor', 'driver_share_bps', 'kona_commission_bps'],
    order_status_update: ['status'],
    driver_location_update: ['h3_cell'],
    dispatch_offer_response: ['accepted', 'bid_amount_minor'],
  });

// ---------------------------------------------------------------------------
// Payload minification & expansion
// ---------------------------------------------------------------------------

/**
 * Builds a compact payload object containing only the essential fields for
 * the given action type, with all canonical key names replaced by their
 * 2-character abbreviations.  Null and undefined fields are omitted to
 * save characters (e.g. absent bid_amount_minor in dispatch_offer_response).
 */
function minifyPayload(
  actionType: OfflineActionType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const essential = ESSENTIAL_FIELDS[actionType];
  const out: Record<string, unknown> = {};
  for (const canonicalKey of essential) {
    const value = payload[canonicalKey];
    if (value === undefined || value === null) {
      continue;
    }
    const abbrev = KEY_ENCODE[canonicalKey];
    if (abbrev === undefined) {
      throw new Error(
        `[minifyPayload] No abbreviation registered for canonical key '${canonicalKey}'. ` +
          `Add it to KEY_ENCODE.`,
      );
    }
    out[abbrev] = value;
  }
  return out;
}

/**
 * Inverts minifyPayload: replaces every abbreviated key with its canonical
 * counterpart.  An unrecognised abbreviation causes an immediate throw so
 * the backend surfaces a clear version-mismatch error rather than silently
 * dropping a field.
 */
function expandPayload(minified: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const abbrev of Object.keys(minified)) {
    const canonical = KEY_DECODE[abbrev];
    if (canonical === undefined) {
      throw new Error(
        `[expandPayload] Unknown abbreviated key '${abbrev}'. ` +
          `The wire string may have been encoded with a newer version of TelephonyBridge.`,
      );
    }
    out[canonical] = minified[abbrev];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The fully rehydrated structure returned by decodeSMSToAction.
 * Every field maps directly to the contracts declared in SPRINT1_SCHEMA.sql.
 */
export interface DecodedSMSAction {
  /** Canonical UUID of the ride_order, identical to ride_orders.order_id. */
  order_id: string;
  /** Lifecycle or ledger event type, identical to OfflineActionType. */
  action_type: OfflineActionType;
  /**
   * Canonical payload with full key names as expected by the PostgreSQL
   * backend handlers.  Only essential fields are present; the backend
   * reconstructs account-level details from the order_id.
   */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Primary encoder
// ---------------------------------------------------------------------------

/**
 * Encodes a KONA offline transaction into a compact SMS/USSD wire string.
 *
 * Encoding pipeline:
 *   1. Validates orderId as a well-formed UUID.
 *   2. Strips non-essential payload fields for the given actionType.
 *   3. Replaces canonical key names with 2-char abbreviations.
 *   4. JSON.stringifies the minified object (no whitespace).
 *   5. UTF-8 encodes the JSON string to bytes.
 *   6. Base45-encodes the UUID bytes (→ 24 chars) and the JSON bytes separately.
 *   7. Assembles the wire frame: K{AT}_{OID_B45}_{DATA_B45}.
 *   8. Validates the result does not exceed SMS_MAX_CHARS (160).
 *
 * @param orderId    – Canonical UUID of the ride_order (ride_orders.order_id).
 * @param actionType – Lifecycle or ledger event type matching OfflineActionType.
 * @param payload    – Full canonical payload with long key names.
 * @returns            Wire-format string, always ≤ 160 characters.
 * @throws TypeError   if orderId is not a valid UUID or actionType is unknown.
 * @throws RangeError  if the encoded result exceeds SMS_MAX_CHARS.
 */
export function encodeActionToSMS(
  orderId: string,
  actionType: OfflineActionType,
  payload: Record<string, unknown>,
): string {
  const actionCode = ACTION_ENCODE[actionType];
  if (actionCode === undefined) {
    throw new TypeError(
      `[encodeActionToSMS] Unknown actionType: '${String(actionType)}'. ` +
        `Valid values: ${Object.keys(ACTION_ENCODE).join(', ')}.`,
    );
  }

  // uuidToCompact throws TypeError if orderId is not a valid UUID.
  const oidCompact = uuidToCompact(orderId);

  const minified = minifyPayload(actionType, payload);
  const jsonString = JSON.stringify(minified);
  const jsonBytes = utf8Encode(jsonString);
  const dataCompact = base45Encode(jsonBytes);

  const wire =
    WIRE_PREFIX + actionCode + SEGMENT_SEP + oidCompact + SEGMENT_SEP + dataCompact;

  if (wire.length > SMS_MAX_CHARS) {
    throw new RangeError(
      `[encodeActionToSMS] Encoded string is ${wire.length} characters, ` +
        `exceeding the ${SMS_MAX_CHARS}-character SMS/USSD limit by ` +
        `${wire.length - SMS_MAX_CHARS} chars. ` +
        `Action: '${actionType}'. Shorten string-valued payload fields.`,
    );
  }

  return wire;
}

// ---------------------------------------------------------------------------
// Primary decoder
// ---------------------------------------------------------------------------

/**
 * Fully rehydrates a KONA SMS/USSD wire string back into the canonical JSON
 * contract expected by the PostgreSQL backend handlers defined in
 * SPRINT1_SCHEMA.sql.
 *
 * Decoding pipeline:
 *   1. Validates the string is non-empty and starts with the KONA prefix 'K'.
 *   2. Splits on '_' and asserts exactly 3 segments are present.
 *   3. Extracts and validates the 2-char action type code from segment[0].
 *   4. Validates segment[1] (OID_B45) is exactly 24 characters.
 *   5. Base45-decodes the OID bytes and reconstructs the lowercase UUID string.
 *   6. Base45-decodes segment[2] (DATA_B45) bytes.
 *   7. UTF-8-decodes the bytes to a JSON string.
 *   8. JSON.parses to a minified payload object.
 *   9. Expands abbreviated keys back to canonical names.
 *
 * @param matrixString – A wire string produced by encodeActionToSMS.
 * @returns              DecodedSMSAction with order_id, action_type, payload.
 * @throws TypeError     if matrixString is not a non-empty string.
 * @throws Error         on any structural, alphabet, or value-range violation.
 */
export function decodeSMSToAction(matrixString: string): DecodedSMSAction {
  if (typeof matrixString !== 'string' || matrixString.length === 0) {
    throw new TypeError('[decodeSMSToAction] Input must be a non-empty string.');
  }

  if (!matrixString.startsWith(WIRE_PREFIX)) {
    throw new Error(
      `[decodeSMSToAction] Invalid wire string: expected KONA prefix '${WIRE_PREFIX}', ` +
        `got '${matrixString[0]}' (char code ${matrixString.charCodeAt(0)}).`,
    );
  }

  const segments = matrixString.split(SEGMENT_SEP);
  if (segments.length !== EXPECTED_SEGMENT_COUNT) {
    throw new Error(
      `[decodeSMSToAction] Expected ${EXPECTED_SEGMENT_COUNT} ` +
        `'${SEGMENT_SEP}'-separated segments, got ${segments.length}. ` +
        `Input: '${matrixString}'.`,
    );
  }

  // segment[0] = "K{AT}" e.g. "KBL" — strip the 'K' prefix to get the 2-char code.
  const headerSegment = segments[0];
  const oidSegment = segments[1];
  const dataSegment = segments[2];

  const actionCode = headerSegment.slice(WIRE_PREFIX.length);
  if (actionCode.length !== 2) {
    throw new Error(
      `[decodeSMSToAction] Action code must be exactly 2 characters, ` +
        `got '${actionCode}' (${actionCode.length} chars).`,
    );
  }

  const actionType = ACTION_DECODE[actionCode];
  if (actionType === undefined) {
    throw new Error(
      `[decodeSMSToAction] Unknown action type code '${actionCode}'. ` +
        `Known codes: ${Object.keys(ACTION_DECODE).join(', ')}.`,
    );
  }

  if (oidSegment.length !== UUID_COMPACT_LENGTH) {
    throw new Error(
      `[decodeSMSToAction] OID segment must be exactly ${UUID_COMPACT_LENGTH} ` +
        `Base45 characters, got ${oidSegment.length}.`,
    );
  }

  // Decode order_id — compactToUuid also validates byte count after decode.
  const orderId = compactToUuid(oidSegment);

  // Decode payload.
  const dataBytes = base45Decode(dataSegment);
  const jsonString = utf8Decode(dataBytes);

  let minified: Record<string, unknown>;
  try {
    minified = JSON.parse(jsonString) as Record<string, unknown>;
  } catch (parseErr) {
    throw new Error(
      `[decodeSMSToAction] Failed to JSON.parse rehydrated payload string: ` +
        `${String(parseErr)}. Decoded string: '${jsonString}'.`,
    );
  }

  if (
    typeof minified !== 'object' ||
    minified === null ||
    Array.isArray(minified)
  ) {
    throw new Error(
      `[decodeSMSToAction] Decoded payload must be a JSON object, ` +
        `got: ${JSON.stringify(minified)}.`,
    );
  }

  const payload = expandPayload(minified);

  return { order_id: orderId, action_type: actionType, payload };
}

// ---------------------------------------------------------------------------
// Inline Sprint 3 verification
// ---------------------------------------------------------------------------

/**
 * Runs a complete encode → wire → decode round-trip for every OfflineActionType
 * and emits a structured verification report to console.log.
 *
 * The booking_lock case intentionally includes non-essential fields
 * (full account UUIDs) in the source payload to prove they are stripped
 * before encoding and are absent from the rehydrated output.
 *
 * Invocation:
 *   import { runSprint3Verification } from './utils/TelephonyBridge';
 *   runSprint3Verification();
 *   — or —
 *   npx ts-node src/utils/TelephonyBridge.ts
 */
export function runSprint3Verification(): void {
  const ORDER_ID = 'b1a2c3d4-e5f6-7890-abcd-ef1234567890';

  type Case = {
    label: string;
    orderId: string;
    actionType: OfflineActionType;
    payload: Record<string, unknown>;
    /** Fields expected to survive the round-trip, keyed by canonical name. */
    expectedPayload: Record<string, unknown>;
  };

  const cases: Case[] = [
    {
      label: 'booking_lock (full fare split + escrow timeout)',
      orderId: ORDER_ID,
      actionType: 'booking_lock',
      // Non-essential account UUID fields must be stripped during encode.
      payload: {
        currency_code: 'USD',
        driver_storage_wallet_account_id: 'acct_78910-driver-wallet',
        client_payment_node_id: 'acct_12345-client-node',
        fare_minor: 4500,
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
        escrow_timeout_at: 1765000000000,
      },
      expectedPayload: {
        currency_code: 'USD',
        fare_minor: 4500,
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
        escrow_timeout_at: 1765000000000,
      },
    },
    {
      label: 'booking_reversal (timeout)',
      orderId: ORDER_ID,
      actionType: 'booking_reversal',
      payload: { reversal_reason: 'timeout' },
      expectedPayload: { reversal_reason: 'timeout' },
    },
    {
      label: 'trip_settlement',
      orderId: ORDER_ID,
      actionType: 'trip_settlement',
      payload: { fare_minor: 4500, driver_share_bps: 8000, kona_commission_bps: 2000 },
      expectedPayload: { fare_minor: 4500, driver_share_bps: 8000, kona_commission_bps: 2000 },
    },
    {
      label: 'order_status_update (in_trip)',
      orderId: ORDER_ID,
      actionType: 'order_status_update',
      payload: { status: 'in_trip' },
      expectedPayload: { status: 'in_trip' },
    },
    {
      label: 'driver_location_update (H3 resolution-9 cell)',
      orderId: ORDER_ID,
      actionType: 'driver_location_update',
      payload: { h3_cell: '8928308280fffff' },
      expectedPayload: { h3_cell: '8928308280fffff' },
    },
    {
      label: 'dispatch_offer_response (accepted with bid)',
      orderId: ORDER_ID,
      actionType: 'dispatch_offer_response',
      payload: { accepted: true, bid_amount_minor: 4500 },
      expectedPayload: { accepted: true, bid_amount_minor: 4500 },
    },
    {
      label: 'dispatch_offer_response (accepted at quoted fare, no bid)',
      orderId: ORDER_ID,
      actionType: 'dispatch_offer_response',
      payload: { accepted: true },
      expectedPayload: { accepted: true },
    },
  ];

  type CaseReport =
    | {
        case: string;
        result: 'PASS';
        action_type: string;
        encoded_wire: string;
        wire_char_count: number;
        within_160_char_limit: boolean;
        decoded_order_id: string;
        decoded_action_type: string;
        decoded_payload: Record<string, unknown>;
        payload_fields_verified: boolean;
      }
    | {
        case: string;
        result: 'FAIL';
        error: string;
      };

  const report: CaseReport[] = [];
  let allPassed = true;

  for (const c of cases) {
    try {
      const encoded = encodeActionToSMS(c.orderId, c.actionType, c.payload);
      const decoded = decodeSMSToAction(encoded);

      // Structural round-trip checks.
      if (decoded.order_id.toLowerCase() !== c.orderId.toLowerCase()) {
        throw new Error(
          `order_id mismatch: expected '${c.orderId}', got '${decoded.order_id}'.`,
        );
      }
      if (decoded.action_type !== c.actionType) {
        throw new Error(
          `action_type mismatch: expected '${c.actionType}', got '${decoded.action_type}'.`,
        );
      }

      // Payload field-level round-trip checks.
      for (const [key, expectedValue] of Object.entries(c.expectedPayload)) {
        const gotValue = decoded.payload[key];
        if (gotValue !== expectedValue) {
          throw new Error(
            `Payload field '${key}' round-trip failed: ` +
              `expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(gotValue)}.`,
          );
        }
      }

      // Confirm non-essential fields were stripped (not present in decoded payload).
      for (const key of Object.keys(c.payload)) {
        if (
          !(ESSENTIAL_FIELDS[c.actionType] as readonly string[]).includes(key) &&
          key in decoded.payload
        ) {
          throw new Error(
            `Non-essential field '${key}' was not stripped during encode.`,
          );
        }
      }

      report.push({
        case: c.label,
        result: 'PASS',
        action_type: c.actionType,
        encoded_wire: encoded,
        wire_char_count: encoded.length,
        within_160_char_limit: encoded.length <= SMS_MAX_CHARS,
        decoded_order_id: decoded.order_id,
        decoded_action_type: decoded.action_type,
        decoded_payload: decoded.payload,
        payload_fields_verified: true,
      });
    } catch (err) {
      allPassed = false;
      report.push({
        case: c.label,
        result: 'FAIL',
        error: String(err),
      });
    }
  }

  const verificationLog = {
    sprint: 'Sprint 3 – Low-Bandwidth Base45 Matrix & USSD/SMS Telephony Bridge',
    timestamp_utc: new Date().toISOString(),
    overall_result: allPassed ? 'PASS' : 'FAIL',
    codec: {
      wire_format: 'K{AT}_{OID_B45}_{DATA_B45}',
      base45_standard: 'RFC 9285',
      separator_char: SEGMENT_SEP,
      uuid_compact_chars: UUID_COMPACT_LENGTH,
      sms_max_chars: SMS_MAX_CHARS,
    },
    cases: report,
  };

  console.log(
    '\n[TelephonyBridge] Sprint 3 Verification Report:\n' +
      JSON.stringify(verificationLog, null, 2),
  );

  if (!allPassed) {
    throw new Error(
      '[TelephonyBridge] One or more verification cases failed. ' +
        'See the report above for details.',
    );
  }
}

// Automatically executes runSprint3Verification when this file is run directly
// via `npx ts-node src/utils/TelephonyBridge.ts` or the compiled JS equivalent.
// Does NOT execute during Jest test runs or when the module is imported.
if (require.main === module) {
  runSprint3Verification();
}
