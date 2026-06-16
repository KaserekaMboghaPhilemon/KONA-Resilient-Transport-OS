/**
 * smsIntake route — production-grade integration test suite
 *
 * Validates all operational vectors of the POST /api/v1/sms/gateway-webhook
 * endpoint against the real SMSReassemblyManager accumulation pipeline.
 * SyncController.executeAction() is spied on per-test (not mocked at module
 * level) so the full Express → SMSReassemblyManager call chain runs for real
 * while pipeline side-effects are intercepted.
 *
 * Five operational vectors under test:
 *   1. Telecom gateway field normalisation (Twilio ↔ Africa's Talking)
 *   2. Partial frame → HTTP 202 Accepted, SyncController NOT invoked
 *   3. Complete multi-frame payload → Base45 stitch + decode + HTTP 200 +
 *      SyncController.executeAction() called with the exact decoded object
 *   4. Sender spoof protection — TXID sender-mismatch rejection
 *   5. 15-minute TTL cleanup enforced via jest fake timer advancement
 *
 * Run with:
 *   npx jest src/routes/__tests__/smsIntake.test.ts --verbose
 */

import request from 'supertest';
import express, { Application } from 'express';
import base45 from 'base45';

import smsIntakeRouter from '../smsIntake';
import { SMSReassemblyManager } from '../../services/SMSReassemblyManager';
import { SyncController } from '../../controllers/SyncController';

// ---------------------------------------------------------------------------
// Express app fixture
// Mirrors the mounting convention used in a real server entry point.
// ---------------------------------------------------------------------------

const app: Application = express();
// Support both JSON bodies (Africa's Talking / generic) and URL-encoded
// bodies (Twilio webhook default content-type).
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/v1/sms', smsIntakeRouter);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Builds a KONA-protocol framed SMS string.
 * Format: KONA:[TXID]:[N]/[T]:[DATA]
 */
function makeKonaFrame(txId: string, n: number, t: number, data: string): string {
  return `KONA:${txId}:${n}/${t}:${data}`;
}

/**
 * Serialises an object to JSON, converts to a Buffer, and Base45-encodes it
 * into the wire string that SMSReassemblyManager expects.
 */
function encodePayload(obj: Record<string, unknown>): string {
  return base45.encode(Buffer.from(JSON.stringify(obj)));
}

/**
 * Splits a Base45 wire string at the midpoint into two balanced DATA parts
 * suitable for use as the payload of a two-frame KONA transmission.
 * Concatenating the two parts restores the original wire string exactly.
 */
function splitIntoTwoFrames(wire: string): [string, string] {
  const mid = Math.ceil(wire.length / 2);
  return [wire.slice(0, mid), wire.slice(mid)];
}

/**
 * Clears the SMSReassemblyManager static in-memory cache between tests
 * to prevent cross-test contamination. Accesses the private field via a
 * typed assertion — acceptable in a test context where there is no public
 * reset API.
 */
function clearReassemblyCache(): void {
  (SMSReassemblyManager as unknown as { cache: Map<string, unknown> }).cache.clear();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Simulated legitimate device sender. */
const SENDER_A = '+254700000001';
/** Simulated attacker / spoof sender. */
const SENDER_B = '+254700000002';

/** Canonical booking_lock payload used across all positive-path tests. */
const PAYLOAD_BOOKING: Record<string, unknown> = {
  action_type: 'booking_lock',
  order_id: 'ord-AAAA',
  fare_minor: 4500,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('smsIntake — POST /api/v1/sms/gateway-webhook', () => {
  /** Spy on SyncController.executeAction; re-created fresh before each test. */
  let syncSpy: jest.SpyInstance<Promise<void>, [Record<string, unknown>]>;

  beforeEach(() => {
    // Isolate the in-memory accumulation cache from every other test.
    clearReassemblyCache();
    // Prevent real pipeline execution while still recording call arguments.
    syncSpy = jest
      .spyOn(SyncController, 'executeAction')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore the original method so no spy leaks into subsequent test files.
    syncSpy.mockRestore();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Vector 1 — Telecom gateway field normalisation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Vector 1 — Telecom gateway field normalisation (Twilio ↔ Africa\'s Talking)', () => {
    it('maps Twilio From/Body fields (urlencoded) to the reassembly engine and returns HTTP 200', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const frame = makeKonaFrame('TW01', 1, 1, wire);

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: frame });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'booking_lock', order_id: 'ord-AAAA' }),
      );
    });

    it('maps Africa\'s Talking from/text fields (JSON) to the reassembly engine and returns HTTP 200', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const frame = makeKonaFrame('AT01', 1, 1, wire);

      // Africa's Talking sends JSON bodies with lowercase field names.
      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .send({ from: SENDER_A, text: frame });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'booking_lock', order_id: 'ord-AAAA' }),
      );
    });

    it('gives precedence to lowercase from/text over title-case From/Body when both are present', async () => {
      // The route uses `body.from ?? body.From`, so lowercase wins on conflict.
      const wire = encodePayload(PAYLOAD_BOOKING);
      const frame = makeKonaFrame('MX01', 1, 1, wire);

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .send({
          from: SENDER_A,           // ← this sender should be used
          text: frame,              // ← this frame should be processed
          From: '+9999999999',      // ← must be shadowed by 'from'
          Body: 'SHOULD-BE-IGNORED', // ← must be shadowed by 'text'
        });

      expect(res.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'booking_lock' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Vector 2 — Partial frame → HTTP 202 Accepted
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Vector 2 — Partial frame returns HTTP 202 Accepted', () => {
    it('returns 202 when the first of a two-frame sequence arrives', async () => {
      const [part1] = splitIntoTwoFrames(encodePayload(PAYLOAD_BOOKING));

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame('PF01', 1, 2, part1) });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'accepted' });
    });

    it('does not invoke SyncController.executeAction() while the payload is incomplete', async () => {
      const [part1] = splitIntoTwoFrames(encodePayload(PAYLOAD_BOOKING));

      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame('PF02', 1, 2, part1) });

      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('transitions from 202 to 200 only on the final frame of the sequence', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'PF03';

      // First frame: sequence incomplete → 202, SyncController silent.
      const res1 = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 1, 2, part1) });
      expect(res1.status).toBe(202);
      expect(syncSpy).not.toHaveBeenCalled();

      // Second frame: sequence complete → 200, SyncController triggered.
      const res2 = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 2, 2, part2) });
      expect(res2.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Vector 3 — Complete payload: Base45 stitch, decode, and pipeline trigger
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Vector 3 — Complete payload: Base45 stitching, decode, and pipeline trigger', () => {
    it('stitches two raw DATA chunks into the original Base45 wire string and decodes the JSON correctly', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'CP01';

      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 1, 2, part1) });

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 2, 2, part2) });

      expect(res.status).toBe(200);
      // The full original object must survive the encode → split → stitch → decode roundtrip.
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining(PAYLOAD_BOOKING),
      );
    });

    it('calls SyncController.executeAction() exactly once with all decoded payload fields', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'CP02';

      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 1, 2, part1) });

      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 2, 2, part2) });

      expect(syncSpy).toHaveBeenCalledTimes(1);

      // Extract and assert the exact payload passed to the pipeline.
      const [callPayload] = syncSpy.mock.calls[0] as [Record<string, unknown>];
      expect(callPayload).toMatchObject({
        action_type: 'booking_lock',
        order_id: 'ord-AAAA',
        fare_minor: 4500,
      });
    });

    it('returns a structured ok response body with a pipeline confirmation message', async () => {
      const frame = makeKonaFrame('CP03', 1, 1, encodePayload(PAYLOAD_BOOKING));

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .send({ from: SENDER_A, text: frame });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        message: expect.stringContaining('pipeline'),
      });
    });

    it('handles a single-frame (1/1) complete transmission without requiring multi-frame accumulation', async () => {
      const singleFrame = makeKonaFrame('CP04', 1, 1, encodePayload(PAYLOAD_BOOKING));

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: singleFrame });

      expect(res.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Vector 4 — Sender spoof protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Vector 4 — Sender spoof protection: TXID sender-mismatch rejection', () => {
    it('blocks a frame whose sender does not match the phone number that registered the TXID', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'SP01';

      // SENDER_A registers the TXID by sending frame 1.
      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 1, 2, part1) });

      // SENDER_B attempts to complete the transmission using the same TXID.
      const spoofRes = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_B, Body: makeKonaFrame(txId, 2, 2, part2) });

      // processIncomingSegment() returns null on sender mismatch → route returns 202.
      expect(spoofRes.status).toBe(202);
      // The pipeline must never be triggered.
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('allows the legitimate original sender to complete the transmission after a failed spoof attempt', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'SP02';

      // SENDER_A registers frame 1.
      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 1, 2, part1) });

      // SENDER_B's spoof is rejected.
      await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_B, Body: makeKonaFrame(txId, 2, 2, part2) });

      // SENDER_A's legitimate completion still succeeds because the accumulator
      // for txId was NOT corrupted by the blocked spoof frame.
      const legitRes = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: makeKonaFrame(txId, 2, 2, part2) });

      expect(legitRes.status).toBe(200);
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Vector 5 — 15-minute TTL cleanup via fake timer advancement
  // Calls SMSReassemblyManager directly (not through the HTTP route) to avoid
  // fake-timer interference with Node's HTTP layer inside supertest.
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Vector 5 — 15-minute TTL cleanup via jest fake timer advancement', () => {
    beforeEach(() => {
      // Freeze the JS clock at the current real time; Date.now() is also faked.
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('evicts stale incomplete entries when the fake clock advances 16 minutes past the TTL', async () => {
      const cache = (SMSReassemblyManager as unknown as {
        cache: Map<string, unknown>;
      }).cache;
      const txId = 'TL01';

      // Register frame 1/2 — entry enters the accumulation cache.
      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame(txId, 1, 2, 'partialdata'),
      );
      expect(cache.has(txId)).toBe(true);

      // Advance the fake clock by 16 minutes (1 min past the 15-min TTL).
      jest.advanceTimersByTime(16 * 60 * 1000);

      // Any subsequent processIncomingSegment call runs cleanExpiredTransmissions()
      // which must see that Date.now() is now 16 minutes ahead and evict TL01.
      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame('CLN1', 1, 1, encodePayload({ seq: 'cleanup-trigger' })),
      );

      // The stale TL01 entry must have been removed from the cache.
      expect(cache.has(txId)).toBe(false);
    });

    it('re-creates a fresh accumulator for an evicted TXID, treating the late frame as the start of a new incomplete sequence', async () => {
      const wire = encodePayload(PAYLOAD_BOOKING);
      const [part1, part2] = splitIntoTwoFrames(wire);
      const txId = 'TL02';

      // Register frame 1/2 — entry enters the cache.
      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame(txId, 1, 2, part1),
      );

      // Advance past the TTL window.
      jest.advanceTimersByTime(16 * 60 * 1000);

      // Trigger cleanup via a fresh TXID segment.
      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame('CLN2', 1, 1, encodePayload({ seq: 'cleanup-trigger' })),
      );

      // Now send frame 2/2 for the evicted TXID.
      // Because TL02 was evicted, the cache creates a new accumulator that
      // holds only fragment[2] (1 of 2 collected) → sequence still incomplete.
      const result = await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame(txId, 2, 2, part2),
      );

      // 1 of 2 expected fragments present → cannot decode → null.
      expect(result).toBeNull();
      // SyncController must never have been reached (we bypassed the route here).
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('does NOT evict an entry when the clock has advanced by only 14 minutes (still within TTL)', async () => {
      const cache = (SMSReassemblyManager as unknown as {
        cache: Map<string, unknown>;
      }).cache;
      const txId = 'TL03';

      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame(txId, 1, 2, 'partialdata'),
      );

      // 14 minutes — still within the 15-min TTL; entry must survive.
      jest.advanceTimersByTime(14 * 60 * 1000);

      await SMSReassemblyManager.processIncomingSegment(
        SENDER_A,
        makeKonaFrame('CLN3', 1, 1, encodePayload({ seq: 'cleanup-trigger' })),
      );

      expect(cache.has(txId)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Input validation — missing / empty fields and unhandled errors
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Input validation and error handling', () => {
    it('returns HTTP 400 when the sender field (From / from) is absent', async () => {
      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ Body: makeKonaFrame('ABCD', 1, 1, 'data') });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        status: 'error',
        message: expect.stringContaining('From'),
      });
    });

    it('returns HTTP 400 when the message body field (Body / text) is absent', async () => {
      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        status: 'error',
        message: expect.stringContaining('Body'),
      });
    });

    it('returns HTTP 202 when both fields are present but the body does not match the KONA frame format', async () => {
      // Invalid format → processIncomingSegment returns null → 202.
      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: 'Hello this is not a KONA frame' });

      expect(res.status).toBe(202);
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('returns HTTP 500 and an error body when SyncController.executeAction() throws', async () => {
      syncSpy.mockRejectedValueOnce(new Error('Ledger pipeline offline'));

      const frame = makeKonaFrame('ERR1', 1, 1, encodePayload(PAYLOAD_BOOKING));

      const res = await request(app)
        .post('/api/v1/sms/gateway-webhook')
        .type('form')
        .send({ From: SENDER_A, Body: frame });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        status: 'error',
        message: 'Ledger pipeline offline',
      });
    });
  });
});
