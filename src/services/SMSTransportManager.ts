import * as SMS from 'expo-sms';

import type { SmsSenderAdapter } from './SyncManager';
import { CryptoSignatureEngine } from './CryptoSignatureEngine';

// ---------------------------------------------------------------------------
// Wire-frame metadata
// ---------------------------------------------------------------------------

export interface SMSChunk {
  id: string;        // Unique transmission identifier
  index: number;     // Current chunk sequence number
  total: number;     // Total chunks in this payload batch
  body: string;      // The actual string fragment
}

// ---------------------------------------------------------------------------
// SMSTransportManager
//
// Concrete implementation of SmsSenderAdapter.  SyncManager injects an
// instance of this class when constructing on the React Native client so that
// sms_only queue processing routes through the chunked GSM framing pipeline
// rather than attempting a raw Base45 wire-string delivery.
//
// Integration contract with SyncManager:
//   SyncManager.processEntryViaSms() already calls
//   TelephonyBridge.encodeActionToSMS() to produce a ≤160-char Base45 wire
//   string, then passes it to SmsSenderAdapter.send(wireString).
//   SMSTransportManager.send() receives that pre-encoded wire string, applies
//   the KONA:TXID:N/T: frame header via chunkify(), and fires each text
//   frame sequentially through expo-sms.  For well-formed payloads the Base45
//   wire string already fits in a single 160-char SMS window and chunkify()
//   produces exactly one frame.  For edge-case oversized strings it splits
//   them transparently across multiple sequential frames.
//
// Factory method:
//   Use SMSTransportManager.create() when building a SyncManager for
//   production; it checks SMS availability before returning the adapter so the
//   caller can fall back gracefully if the device has no telephony hardware.
// ---------------------------------------------------------------------------

export class SMSTransportManager implements SmsSenderAdapter {
  private static readonly CH_MAX_LEN = 160;
  private static readonly FALLBACK_DEVICE_SECRET = 'KONA_LOCAL_FALLBACK_SECRET';
  private static readonly UNSIGNED_SIGNATURE = '00000000';

  /** E.164 number for the KONA Base Station Gateway. */
  private static readonly GATEWAY_NUMBER = '+254700000000';

  /**
   * Factory method — checks that the device's SMS interface is available
   * before returning a ready-to-use adapter instance.  Callers should use
   * this in preference to direct construction so that a missing telephony
   * hardware layer is surfaced early rather than at first send().
   *
   * @throws Error if the device does not support sending SMS messages.
   */
  static async create(): Promise<SMSTransportManager> {
    const available = await SMS.isAvailableAsync();
    if (!available) {
      throw new Error(
        '[SMSTransportManager] Telephony hardware interface unavailable on this device.',
      );
    }
    return new SMSTransportManager();
  }

  // -------------------------------------------------------------------------
  // SmsSenderAdapter implementation
  // -------------------------------------------------------------------------

  /**
   * Accepts a pre-encoded wire string (produced by
   * TelephonyBridge.encodeActionToSMS) from the SyncManager SMS path,
   * wraps it in KONA frame headers via chunkify(), and dispatches each
   * text frame sequentially through expo-sms.
   *
   * Returns true if every frame was accepted by the telephony layer.
   * Returns false on any frame rejection or expo-sms error so SyncManager's
   * retry circuitry can schedule a backoff and re-attempt delivery.
   */
  async send(wireString: string, deviceSecret?: string): Promise<boolean> {
    const txId = SMSTransportManager.generateTxId();
    const signatureHex = await SMSTransportManager.signPayload(
      wireString,
      deviceSecret,
    );
    const frames = SMSTransportManager.chunkify(wireString, txId, signatureHex);

    console.log(
      `[SMSTransportManager] TX ${txId}: dispatching ${frames.length} frame(s) ` +
        `(wire length: ${wireString.length} chars, sig: ${signatureHex}).`,
    );

    try {
      for (const frame of frames) {
        const { result } = await SMS.sendSMSAsync(
          [SMSTransportManager.GATEWAY_NUMBER],
          frame,
        );

        if (result !== 'sent') {
          throw new Error(
            `[SMSTransportManager] TX ${txId}: frame rejected with status '${result}'.`,
          );
        }
      }

      console.log(`[SMSTransportManager] TX ${txId}: all frames delivered.`);
      return true;
    } catch (error) {
      console.error(
        `[SMSTransportManager] TX ${txId}: broadcast failure.`,
        error,
      );
      return false;
    }
  }

  /**
   * Context-aware chunk transport for non-queue payloads such as telemetry
   * slices. Delegates to the same chunked wire transport used by send().
   */
  async sendPayloadAsChunks(
    payload: string,
    context: 'SYNC' | 'TELEMETRY' = 'SYNC',
    deviceSecret?: string,
  ): Promise<boolean> {
    console.log(
      `[SMSTransportManager] Context ${context}: sending payload ` +
        `(${payload.length} chars) through chunked SMS transport.`,
    );

    return this.send(payload, deviceSecret);
  }

  // -------------------------------------------------------------------------
  // Payload helpers (kept public + static for unit testability)
  // -------------------------------------------------------------------------

  /**
   * Compresses a raw JSON payload into a compact key-value map using a
   * domain-specific dictionary.  Used by transmitPayloadViaSMS() for
   * direct dispatch paths that bypass TelephonyBridge.
   *
   * When invoked from the SyncManager path the payload has already been
   * encoded by TelephonyBridge.encodeActionToSMS(); this method is therefore
   * not called in that flow — it remains available for legacy callers and
   * standalone dispatch.
   */
  public static compressPayload(payload: Record<string, unknown>): string {
    const dictionaryMap: Record<string, string> = {
      driverId:  'd',
      timestamp: 't',
      status:    's',
      latitude:  'x',
      longitude: 'y',
      tripId:    'i',
      amount:    'a',
    };

    const compressed: Record<string, unknown> = {};
    for (const key in payload) {
      compressed[dictionaryMap[key] ?? key] = payload[key];
    }

    return JSON.stringify(compressed);
  }

  /**
   * Slices an already-encoded string into ≤160-char GSM text frames.
   * Each frame is prefixed with a tracking header:
  *   KONA:{TXID}:{N}/{TOTAL}:{SIG}:{DATA}
  * where SIG is an 8-char uppercase hex signature fragment.
   *
   * For well-formed Base45 TelephonyBridge wire strings (≤160 chars) this
   * always returns a single frame, making multi-chunk delivery a transparent
   * safety net rather than a normal-path concern.
   */
  public static chunkify(
    encodedStr: string,
    transmissionId: string,
    signatureHex: string = this.UNSIGNED_SIGNATURE,
  ): string[] {
    if (!encodedStr) {
      return [];
    }

    const normalizedSig = this.normalizeSignature(signatureHex);

    // Total chunk count impacts header width (e.g. 9/9 vs 10/10), so we
    // converge on a stable chunk count before slicing the data payload.
    let totalChunks = 1;
    let dataPerChunk = this.computeDataPerChunk(transmissionId, totalChunks, normalizedSig);
    let recomputedTotal = Math.ceil(encodedStr.length / dataPerChunk);

    while (recomputedTotal !== totalChunks) {
      totalChunks = recomputedTotal;
      dataPerChunk = this.computeDataPerChunk(transmissionId, totalChunks, normalizedSig);
      recomputedTotal = Math.ceil(encodedStr.length / dataPerChunk);
    }

    const frames: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const fragment = encodedStr.slice(i * dataPerChunk, (i + 1) * dataPerChunk);
      frames.push(`KONA:${transmissionId}:${i + 1}/${totalChunks}:${normalizedSig}:${fragment}`);
    }

    return frames;
  }

  /**
   * Legacy standalone dispatch method.  Accepts a raw (unencoded) payload,
   * applies dictionary compression, then chunks and fires it via expo-sms.
   *
   * In SyncManager-integrated flows, prefer the send() path which operates
   * on a TelephonyBridge-encoded wire string for maximum compactness and
   * idempotency-key preservation.
   */
  public static async transmitPayloadViaSMS(
    payload: Record<string, unknown>,
    deviceSecret?: string,
  ): Promise<boolean> {
    const available = await SMS.isAvailableAsync();
    if (!available) {
      console.error('[SMSTransportManager] Telephony hardware interface unavailable on this device.');
      return false;
    }

    const txId      = this.generateTxId();
    const compressed = this.compressPayload(payload);
    const signatureHex = await this.signPayload(compressed, deviceSecret);
    const frames     = this.chunkify(compressed, txId, signatureHex);

    console.log(
      `[SMSTransportManager] TX ${txId}: initiating legacy dispatch. ` +
        `${frames.length} frame(s).`,
    );

    try {
      for (const frame of frames) {
        const { result } = await SMS.sendSMSAsync([this.GATEWAY_NUMBER], frame);
        if (result !== 'sent') {
          throw new Error(
            `Frame rejected with status '${result}'.`,
          );
        }
      }
      return true;
    } catch (error) {
      console.error(
        `[SMSTransportManager] TX ${txId}: broadcast failure on legacy dispatch.`,
        error,
      );
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Generates a 4-character alphanumeric transmission ID. */
  private static generateTxId(): string {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
  }

  /** Ensures all frame signatures are normalized to 8 uppercase hex chars. */
  private static normalizeSignature(signatureHex: string): string {
    const candidate = signatureHex.trim().toUpperCase();
    return /^[A-F0-9]{8}$/.test(candidate) ? candidate : this.UNSIGNED_SIGNATURE;
  }

  /** Computes per-frame data capacity from dynamic header length. */
  private static computeDataPerChunk(
    transmissionId: string,
    totalChunks: number,
    signatureHex: string,
  ): number {
    const header = `KONA:${transmissionId}:${totalChunks}/${totalChunks}:${signatureHex}:`;
    return Math.max(1, this.CH_MAX_LEN - header.length);
  }

  /** Generates an 8-char signature for a payload, with safe fallback behavior. */
  private static async signPayload(payload: string, deviceSecret?: string): Promise<string> {
    const secret = deviceSecret?.trim() || this.FALLBACK_DEVICE_SECRET;
    if (!deviceSecret?.trim()) {
      console.warn(
        '[SMSTransportManager] deviceSecret missing, using fallback secret for signature generation.',
      );
    }

    try {
      return await CryptoSignatureEngine.generateSignature(payload, secret);
    } catch (error) {
      console.error('[SMSTransportManager] Signature generation failed. Falling back to UNSIGNED signature.', error);
      return this.UNSIGNED_SIGNATURE;
    }
  }
}