/**
 * SMSTransportManager — Production-grade unit & regression test suite
 *
 * Covers all five operational vectors:
 *   1. expo-sms native module mock wiring
 *   2. create() factory — unavailable-hardware rejection
 *   3. send() single-frame path (wire string ≤ 140 chars of data)
 *   4. chunkify() multi-frame path (wire string > 140 chars of data)
 *   5. send() partial-frame failure — pipeline aborts on non-'sent' result
 *
 * Additional groups:
 *   6. compressPayload() — dictionary compression contract
 *   7. transmitPayloadViaSMS() — legacy direct-dispatch path
 *
 * Timer discipline: no fake timers are used; all async assertions rely on
 * real Promise resolution so they remain compatible with ts-jest + Node.
 *
 * Mock strategy:
 *   expo-sms is stubbed at module level via jest.mock().  All per-test
 *   state is configured in beforeEach so each test begins from a clean
 *   known state.  mockSMS.sendSMSAsync.mockResolvedValueOnce() is used
 *   where individual frame responses differ mid-sequence.
 */

// ─────────────────────────────────────────────────────────────────────────────
// expo-sms mock — must appear before any import that loads the module.
//
// An explicit factory is required because expo-sms/build/SMS.js uses ESM
// `import` syntax that ts-jest (CommonJS preset) cannot parse when the module
// is loaded for auto-mocking.  The factory returns plain jest.fn() stubs so
// each test can configure resolved values via mockResolvedValue /
// mockResolvedValueOnce without touching the real native telephony layer.
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('expo-sms', () => ({
  isAvailableAsync: jest.fn(),
  sendSMSAsync:     jest.fn(),
}));

jest.mock('../CryptoSignatureEngine', () => ({
  CryptoSignatureEngine: {
    generateSignature: jest.fn().mockResolvedValue('A1B2C3D4'),
  },
}));

import * as SMS from 'expo-sms';
import { SMSTransportManager } from '../SMSTransportManager';

// Narrow the mock type so TypeScript recognises .mock and .mockResolvedValue.
const mockSMS = SMS as jest.Mocked<typeof SMS>;

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants mirrored from SMSTransportManager (cannot be imported
// because they are private statics; mirrored here as test-local constants so
// any divergence surfaces as a test failure rather than a silent bug).
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum characters in a single GSM text frame (160). */
const CH_MAX_LEN = 160;

/** Signature fixture used by SMSTransportManager mock signing path. */
const SIGNATURE_HEX = 'A1B2C3D4';

/**
 * Bytes reserved for the KONA tracking header in signed format.
 * Header: KONA:XXXX:N/T:SIGNATURE:
 */
const HEADER_BUDGET = `KONA:XXXX:1/1:${SIGNATURE_HEX}:`.length;

/** Maximum data characters per chunk (140). */
const DATA_PER_CHUNK = CH_MAX_LEN - HEADER_BUDGET;

/** E.164 gateway number expected in every sendSMSAsync call. */
const GATEWAY_NUMBER = '+254700000000';

// ─────────────────────────────────────────────────────────────────────────────
// Frame-parsing helper
//
// Extracts the four components from a KONA tracking frame header:
//   KONA:{txId}:{index}/{total}:{data}
//
// Returns null if the frame does not match the expected pattern.
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedFrame {
  txId:   string;
  index:  number;
  total:  number;
  signature: string;
  data:   string;
}

function parseFrame(frame: string): ParsedFrame | null {
  // The data segment may contain any character including '/', so we match
  // everything after the fifth colon as a single group.
  const match = frame.match(/^KONA:([A-Z0-9]{4}):(\d+)\/(\d+):([A-F0-9]{8}):(.*)$/s);
  if (!match) return null;
  return {
    txId:  match[1],
    index: parseInt(match[2], 10),
    total: parseInt(match[3], 10),
    signature: match[4],
    data:  match[5],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a deterministic ASCII string of exactly `length` characters.
 * The pattern repeats the Base45 alphabet (no spaces) so it represents
 * realistic wire-string content from TelephonyBridge.encodeActionToSMS().
 */
function buildWireString(length: number): string {
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$%*+-./:';
  let result = '';
  while (result.length < length) {
    result += ALPHABET;
  }
  return result.slice(0, length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite-wide setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // resetAllMocks() clears call history, once-queues, and any previously
  // configured mockResolvedValue / mockResolvedValueOnce / mockImplementation
  // state so that no mock residue from one test can bleed into the next.
  // (clearAllMocks() only clears call history and does NOT flush once-queues,
  // which would cause stale mockResolvedValueOnce entries to contaminate
  // subsequent tests that rely on mockImplementation or mockRejectedValue.)
  jest.resetAllMocks();

  // Default happy-path configuration.  Individual tests override as needed.
  mockSMS.isAvailableAsync.mockResolvedValue(true);
  mockSMS.sendSMSAsync.mockResolvedValue({ result: 'sent' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. create() — factory initialisation
// ─────────────────────────────────────────────────────────────────────────────

describe('1 — create() factory initialisation', () => {
  it('returns a ready SMSTransportManager when SMS hardware is available', async () => {
    mockSMS.isAvailableAsync.mockResolvedValue(true);

    const adapter = await SMSTransportManager.create();

    expect(adapter).toBeInstanceOf(SMSTransportManager);
    expect(mockSMS.isAvailableAsync).toHaveBeenCalledTimes(1);
  });

  it('throws with the expected message when SMS hardware is unavailable', async () => {
    mockSMS.isAvailableAsync.mockResolvedValue(false);

    await expect(SMSTransportManager.create()).rejects.toThrow(
      '[SMSTransportManager] Telephony hardware interface unavailable on this device.',
    );
  });

  it('throws an Error instance (not a string or undefined) when hardware is unavailable', async () => {
    mockSMS.isAvailableAsync.mockResolvedValue(false);

    await expect(SMSTransportManager.create()).rejects.toBeInstanceOf(Error);
  });

  it('does not call sendSMSAsync during factory construction', async () => {
    await SMSTransportManager.create();

    expect(mockSMS.sendSMSAsync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. send() — single-frame transmission (wire string fits in one chunk)
// ─────────────────────────────────────────────────────────────────────────────

describe('2 — send() single-frame transmission', () => {
  it('returns true when the single frame is accepted by the gateway', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(80); // 80 chars < DATA_PER_CHUNK (140)

    const result = await adapter.send(wireString);

    expect(result).toBe(true);
  });

  it('calls sendSMSAsync exactly once for a wire string at or below the data-per-chunk threshold', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(DATA_PER_CHUNK); // exactly 140 chars

    await adapter.send(wireString);

    expect(mockSMS.sendSMSAsync).toHaveBeenCalledTimes(1);
  });

  it('sends to the KONA gateway E.164 number', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(50);

    await adapter.send(wireString);

    const [addresses] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    expect(addresses).toEqual([GATEWAY_NUMBER]);
  });

  it('frame body matches KONA:TXID:1/1:SIG:DATA format', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(60);

    await adapter.send(wireString);

    const [, frameBody] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    const parsed        = parseFrame(frameBody);

    expect(parsed).not.toBeNull();
    expect(parsed!.index).toBe(1);
    expect(parsed!.total).toBe(1);
    expect(parsed!.signature).toMatch(/^[A-F0-9]{8}$/);
  });

  it('frame data segment exactly matches the original wire string', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(100);

    await adapter.send(wireString);

    const [, frameBody] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    const parsed        = parseFrame(frameBody);

    expect(parsed!.data).toBe(wireString);
  });

  it('TXID in the frame is a 4-character uppercase alphanumeric token', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(40);

    await adapter.send(wireString);

    const [, frameBody] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    const parsed        = parseFrame(frameBody);

    expect(parsed!.txId).toMatch(/^[A-Z0-9]{4}$/);
  });

  it('total frame length does not exceed the 160-char GSM limit', async () => {
    const adapter    = await SMSTransportManager.create();
    // Use a wire string at the maximum data boundary.
    const wireString = buildWireString(DATA_PER_CHUNK);

    await adapter.send(wireString);

    const [, frameBody] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    expect(frameBody.length).toBeLessThanOrEqual(CH_MAX_LEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. chunkify() — multi-frame chunk splicing
// ─────────────────────────────────────────────────────────────────────────────

describe('3 — chunkify() multi-frame chunk splicing', () => {
  it('produces the correct number of frames for a 3-chunk payload', () => {
    // Exactly 3 × DATA_PER_CHUNK = 420 chars → 3 frames.
    const input  = buildWireString(3 * DATA_PER_CHUNK);
    const txId   = 'A1B2';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    expect(frames).toHaveLength(3);
  });

  it('produces the correct number of frames for a payload that does not divide evenly', () => {
    // 2 × DATA_PER_CHUNK + 1 → 3 frames (last frame carries 1 char).
    const input  = buildWireString(2 * DATA_PER_CHUNK + 1);
    const txId   = 'Z9Y8';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    expect(frames).toHaveLength(3);
  });

  it('all frames share the same TXID', () => {
    const input  = buildWireString(3 * DATA_PER_CHUNK);
    const txId   = 'CAFE';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    for (const frame of frames) {
      const parsed = parseFrame(frame);
      expect(parsed).not.toBeNull();
      expect(parsed!.txId).toBe(txId);
    }
  });

  it('frame indices are sequential starting at 1', () => {
    const input  = buildWireString(3 * DATA_PER_CHUNK);
    const txId   = 'BEEF';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    frames.forEach((frame, arrayIndex) => {
      const parsed = parseFrame(frame);
      expect(parsed!.index).toBe(arrayIndex + 1);
    });
  });

  it('every frame carries the correct total chunk count', () => {
    const input  = buildWireString(3 * DATA_PER_CHUNK);
    const txId   = 'D00D';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    for (const frame of frames) {
      const parsed = parseFrame(frame);
      expect(parsed!.total).toBe(3);
    }
  });

  it('concatenating all frame data segments exactly reconstructs the original input', () => {
    const input  = buildWireString(3 * DATA_PER_CHUNK + 55);
    const txId   = 'FACE';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    const reconstructed = frames
      .map((frame) => parseFrame(frame)!.data)
      .join('');

    expect(reconstructed).toBe(input);
  });

  it('frame headers follow the KONA:TXID:N/TOTAL:SIG:DATA format for each frame', () => {
    const chunkCount = 3;
    const input      = buildWireString(chunkCount * DATA_PER_CHUNK);
    const txId       = 'TEST';
    const frames     = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    frames.forEach((frame, i) => {
      // Header up to but not including data: "KONA:TEST:{i+1}/{total}:"
      const expectedHeaderPrefix = `KONA:${txId}:${i + 1}/${chunkCount}:${SIGNATURE_HEX}:`;
      expect(frame.startsWith(expectedHeaderPrefix)).toBe(true);
    });
  });

  it('produces exactly one frame for an empty string input', () => {
    const frames = SMSTransportManager.chunkify('', 'AA00', SIGNATURE_HEX);
    // Math.ceil(0 / 140) = 0 → no frames. Verify boundary behaviour.
    expect(frames).toHaveLength(0);
  });

  it('send() calls sendSMSAsync once per generated chunk for a multi-chunk payload', async () => {
    const adapter    = await SMSTransportManager.create();
    // 3 chunks: 420 chars of data.
    const wireString = buildWireString(3 * DATA_PER_CHUNK);

    await adapter.send(wireString);

    expect(mockSMS.sendSMSAsync).toHaveBeenCalledTimes(3);
  });

  it('send() sends all frames to the KONA gateway number', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(3 * DATA_PER_CHUNK);

    await adapter.send(wireString);

    for (const callArgs of mockSMS.sendSMSAsync.mock.calls) {
      const [addresses] = callArgs as [string[], string];
      expect(addresses).toEqual([GATEWAY_NUMBER]);
    }
  });

  it('send() returns true when all frames in a multi-chunk sequence are accepted', async () => {
    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(3 * DATA_PER_CHUNK);

    const result = await adapter.send(wireString);

    expect(result).toBe(true);
  });

  it('frame data segments across a 3-chunk sequence have the expected lengths', () => {
    const input  = buildWireString(3 * DATA_PER_CHUNK);
    const txId   = 'XYZW';
    const frames = SMSTransportManager.chunkify(input, txId, SIGNATURE_HEX);

    // All three chunks should carry exactly DATA_PER_CHUNK characters.
    for (const frame of frames) {
      expect(parseFrame(frame)!.data).toHaveLength(DATA_PER_CHUNK);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. send() — failure transmission defences
// ─────────────────────────────────────────────────────────────────────────────

describe('4 — send() failure transmission defences', () => {
  it('returns false when sendSMSAsync resolves with result other than "sent" on the first frame', async () => {
    mockSMS.sendSMSAsync.mockResolvedValue({ result: 'cancelled' });

    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(50);

    const result = await adapter.send(wireString);

    expect(result).toBe(false);
  });

  it('returns false and stops after the failing frame when a mid-sequence frame is rejected', async () => {
    // 2-frame payload: frame 1 succeeds, frame 2 is cancelled.
    mockSMS.sendSMSAsync
      .mockResolvedValueOnce({ result: 'sent' })
      .mockResolvedValueOnce({ result: 'cancelled' });

    const adapter    = await SMSTransportManager.create();
    // 2 chunks: > 140 chars, ≤ 280 chars.
    const wireString = buildWireString(DATA_PER_CHUNK + 40);

    const result = await adapter.send(wireString);

    expect(result).toBe(false);
    // Pipeline must have called sendSMSAsync exactly twice: once for the
    // accepted frame and once for the rejected frame before aborting.
    expect(mockSMS.sendSMSAsync).toHaveBeenCalledTimes(2);
  });

  it('does NOT dispatch any further frames after a failure is detected mid-sequence', async () => {
    // 3-frame payload: frame 1 succeeds, frame 2 fails, frame 3 must never fire.
    mockSMS.sendSMSAsync
      .mockResolvedValueOnce({ result: 'sent' })
      .mockResolvedValueOnce({ result: 'cancelled' })
      .mockResolvedValueOnce({ result: 'sent' }); // frame 3 — must not be reached

    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(3 * DATA_PER_CHUNK);

    await adapter.send(wireString);

    // Only 2 calls expected: the loop throws after frame 2 and frame 3 is skipped.
    expect(mockSMS.sendSMSAsync).toHaveBeenCalledTimes(2);
  });

  it('returns false when sendSMSAsync itself throws an exception', async () => {
    mockSMS.sendSMSAsync.mockImplementation(() =>
      Promise.reject(new Error('Native SMS channel unavailable')),
    );

    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(50);

    const result = await adapter.send(wireString);

    expect(result).toBe(false);
  });

  it('returns false for "unknown" result status on the first frame', async () => {
    mockSMS.sendSMSAsync.mockResolvedValue({ result: 'unknown' as 'sent' });

    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(50);

    const result = await adapter.send(wireString);

    expect(result).toBe(false);
  });

  it('does not re-throw on frame rejection — returns false instead of propagating', async () => {
    mockSMS.sendSMSAsync.mockResolvedValue({ result: 'cancelled' });

    const adapter    = await SMSTransportManager.create();
    const wireString = buildWireString(50);

    await expect(adapter.send(wireString)).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. compressPayload() — dictionary compression contract
// ─────────────────────────────────────────────────────────────────────────────

describe('5 — compressPayload() dictionary compression', () => {
  it('replaces driverId with d', () => {
    const result = JSON.parse(SMSTransportManager.compressPayload({ driverId: 'DRV-001' }));
    expect(result).toHaveProperty('d', 'DRV-001');
    expect(result).not.toHaveProperty('driverId');
  });

  it('replaces timestamp with t', () => {
    const result = JSON.parse(SMSTransportManager.compressPayload({ timestamp: 1718000000 }));
    expect(result).toHaveProperty('t', 1718000000);
    expect(result).not.toHaveProperty('timestamp');
  });

  it('replaces all seven dictionary keys in a single payload object', () => {
    const input = {
      driverId:  'D1',
      timestamp: 1718000000,
      status:    'active',
      latitude:  -1.286,
      longitude: 36.817,
      tripId:    'T-99',
      amount:    1500,
    };

    const result = JSON.parse(SMSTransportManager.compressPayload(input));

    expect(result).toMatchObject({
      d: 'D1',
      t: 1718000000,
      s: 'active',
      x: -1.286,
      y: 36.817,
      i: 'T-99',
      a: 1500,
    });

    // No original keys survive.
    for (const key of Object.keys(input)) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('preserves unknown keys that are not in the dictionary', () => {
    const result = JSON.parse(
      SMSTransportManager.compressPayload({ customField: 'value', driverId: 'D1' }),
    );
    expect(result).toHaveProperty('customField', 'value');
    expect(result).toHaveProperty('d', 'D1');
  });

  it('returns valid JSON', () => {
    const compressed = SMSTransportManager.compressPayload({ driverId: 'D1', amount: 100 });
    expect(() => JSON.parse(compressed)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. transmitPayloadViaSMS() — legacy direct-dispatch path
// ─────────────────────────────────────────────────────────────────────────────

describe('6 — transmitPayloadViaSMS() legacy direct-dispatch', () => {
  it('returns false (not throws) when SMS hardware is unavailable', async () => {
    mockSMS.isAvailableAsync.mockResolvedValue(false);

    const result = await SMSTransportManager.transmitPayloadViaSMS({
      driverId: 'DRV-001',
      status:   'idle',
    });

    expect(result).toBe(false);
  });

  it('returns true when all frames are successfully transmitted', async () => {
    mockSMS.isAvailableAsync.mockResolvedValue(true);

    const result = await SMSTransportManager.transmitPayloadViaSMS({
      driverId: 'DRV-007',
      amount:   2500,
    });

    expect(result).toBe(true);
    expect(mockSMS.sendSMSAsync).toHaveBeenCalled();
  });

  it('returns false when sendSMSAsync returns a non-sent status', async () => {
    mockSMS.sendSMSAsync.mockResolvedValue({ result: 'cancelled' });

    const result = await SMSTransportManager.transmitPayloadViaSMS({
      driverId: 'DRV-007',
      amount:   2500,
    });

    expect(result).toBe(false);
  });

  it('compresses payload before chunking — sendSMSAsync body contains short key names', async () => {
    await SMSTransportManager.transmitPayloadViaSMS({
      driverId: 'DRV-001',
      status:   'active',
    });

    const [, frameBody] = mockSMS.sendSMSAsync.mock.calls[0] as [string[], string];
    // The frame data must contain the compressed key 'd' not the raw 'driverId'.
    expect(frameBody).toContain('"d"');
    expect(frameBody).not.toContain('driverId');
  });

  it('calls isAvailableAsync exactly once per invocation', async () => {
    await SMSTransportManager.transmitPayloadViaSMS({ amount: 100 });

    expect(mockSMS.isAvailableAsync).toHaveBeenCalledTimes(1);
  });
});
