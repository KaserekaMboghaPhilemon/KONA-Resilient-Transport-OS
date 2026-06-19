import base45 from 'base45';

interface SMSChunkAccumulator {
  sender: string;
  totalChunks: number;
  signatureHex: string | null;
  fragments: Record<number, string>; // Maps chunkIndex --> dataFragment
  createdAt: Date;
}

export class SMSReassemblyManager {
  // In-memory aggregation cache (swap to Redis for multi-instance scaling)
  private static cache: Map<string, SMSChunkAccumulator> = new Map();

  // TTL: clean up stale incomplete transmissions after 15 minutes
  private static TTL_MS = 15 * 60 * 1000;

  /**
   * Parses and accumulates an incoming SMS string segment.
   * Returns the fully-decoded payload object once all chunks have arrived,
   * or null when more frames are still expected.
   */
  public static async processIncomingSegment(
    sender: string,
    rawBody: string,
  ): Promise<Record<string, unknown> | null> {
    this.cleanExpiredTransmissions();

    const parsedFrame = this.parseFrame(rawBody);
    if (!parsedFrame) {
      console.warn(`[SMS Intake] Invalid frame format received from ${sender}`);
      return null;
    }

    const {
      txId,
      chunkIndex,
      totalChunks,
      signatureHex,
      dataFragment,
    } = parsedFrame;

    console.log(
      `[SMS Intake] Received frame ${chunkIndex}/${totalChunks} for TXID: ${txId} from ${sender}`,
    );

    // Retrieve or create the accumulator record for this transmission.
    let record = this.cache.get(txId);
    if (!record) {
      record = {
        sender,
        totalChunks,
        signatureHex,
        fragments: {},
        createdAt: new Date(),
      };
      this.cache.set(txId, record);
    }

    // Security: reject frames whose sender doesn't match the original sender
    // for this TXID, preventing spoofed injection into an active accumulation.
    if (record.sender !== sender) {
      console.error(`[SMS Intake] Security Violation: TXID ${txId} sender mismatch.`);
      return null;
    }

    // Security: signed transmissions must keep a stable signature across all frames.
    if (record.signatureHex !== signatureHex) {
      console.error(`[SMS Intake] Security Violation: TXID ${txId} signature mismatch across frames.`);
      return null;
    }

    // Store the fragment at its 1-based index position.
    record.fragments[chunkIndex] = dataFragment;

    // Check if all expected chunks have now arrived.
    const collectedCount = Object.keys(record.fragments).length;
    if (collectedCount === totalChunks) {
      return this.reassembleAndDecode(txId, record);
    }

    // Payload is still incomplete — waiting for more frames.
    return null;
  }

  /**
   * Parses both Sprint 11 signed frames and legacy unsigned frames.
   * Signed:   KONA:[TXID]:[N]/[T]:[SIG_HEX]:[DATA]
   * Unsigned: KONA:[TXID]:[N]/[T]:[DATA]
   */
  private static parseFrame(rawBody: string): {
    txId: string;
    chunkIndex: number;
    totalChunks: number;
    signatureHex: string | null;
    dataFragment: string;
  } | null {
    if (!rawBody.startsWith('KONA:')) {
      return null;
    }

    const withoutPrefix = rawBody.slice('KONA:'.length);
    const firstColon = withoutPrefix.indexOf(':');
    if (firstColon <= 0) {
      return null;
    }

    const txId = withoutPrefix.slice(0, firstColon);
    if (!/^[A-Z0-9]{4}$/.test(txId)) {
      return null;
    }

    const remainderAfterTx = withoutPrefix.slice(firstColon + 1);
    const secondColon = remainderAfterTx.indexOf(':');
    if (secondColon <= 0) {
      return null;
    }

    const sequencePart = remainderAfterTx.slice(0, secondColon);
    const payloadPart = remainderAfterTx.slice(secondColon + 1);

    const sequenceMatch = sequencePart.match(/^(\d+)\/(\d+)$/);
    if (!sequenceMatch) {
      return null;
    }

    const chunkIndex = parseInt(sequenceMatch[1], 10);
    const totalChunks = parseInt(sequenceMatch[2], 10);
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks)) {
      return null;
    }

    const sigSeparatorIndex = payloadPart.indexOf(':');
    if (sigSeparatorIndex > 0) {
      const sigCandidate = payloadPart.slice(0, sigSeparatorIndex).toUpperCase();
      const dataCandidate = payloadPart.slice(sigSeparatorIndex + 1);

      if (/^[A-F0-9]{8}$/.test(sigCandidate) && dataCandidate.length > 0) {
        return {
          txId,
          chunkIndex,
          totalChunks,
          signatureHex: sigCandidate,
          dataFragment: dataCandidate,
        };
      }
    }

    // Legacy unsigned fallback.
    return {
      txId,
      chunkIndex,
      totalChunks,
      signatureHex: null,
      dataFragment: payloadPart,
    };
  }

  /**
   * Stitches ordered fragments together and decodes the Base45-encoded JSON.
   */
  private static reassembleAndDecode(
    txId: string,
    record: SMSChunkAccumulator,
  ): Record<string, unknown> | null {
    try {
      let fullWireString = '';
      for (let i = 1; i <= record.totalChunks; i++) {
        const frag = record.fragments[i];
        if (!frag) {
          throw new Error(`Missing segment at index ${i} for TXID ${txId}`);
        }
        fullWireString += frag;
      }

      const decodedBuffer = base45.decode(fullWireString);
      const jsonString = decodedBuffer.toString('utf-8');
      const payload = JSON.parse(jsonString) as Record<string, unknown>;

      // Pass signed-wire metadata downstream for server-side authentication.
      payload.__kona_signature_hex = record.signatureHex;
      payload.__kona_raw_wire = fullWireString;

      console.log(`[SMS Intake] Successfully reassembled and decoded TXID: ${txId}`);

      this.cache.delete(txId);
      return payload;
    } catch (error) {
      console.error(
        `[SMS Intake] Failed to decode reassembled payload for TXID ${txId}:`,
        error,
      );
      this.cache.delete(txId);
      return null;
    }
  }

  /**
   * Removes stale, abandoned chunk groups to prevent unbounded memory growth.
   */
  private static cleanExpiredTransmissions(): void {
    const now = Date.now();
    for (const [txId, record] of this.cache.entries()) {
      if (now - record.createdAt.getTime() > this.TTL_MS) {
        this.cache.delete(txId);
        console.log(`[SMS Intake] Purged stale incomplete TXID: ${txId}`);
      }
    }
  }
}
