import base45 from 'base45';

interface SMSChunkAccumulator {
  sender: string;
  totalChunks: number;
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

    // Frame format: KONA:[TXID]:[N]/[T]:[DATA]
    const headerRegex = /^KONA:([A-Z0-9]{4}):(\d+)\/(\d+):(.+)$/s;
    const match = rawBody.match(headerRegex);

    if (!match) {
      console.warn(`[SMS Intake] Invalid frame format received from ${sender}`);
      return null;
    }

    const [, txId, nStr, tStr, dataFragment] = match;
    const chunkIndex = parseInt(nStr, 10);
    const totalChunks = parseInt(tStr, 10);

    console.log(
      `[SMS Intake] Received frame ${chunkIndex}/${totalChunks} for TXID: ${txId} from ${sender}`,
    );

    // Retrieve or create the accumulator record for this transmission.
    let record = this.cache.get(txId);
    if (!record) {
      record = {
        sender,
        totalChunks,
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
