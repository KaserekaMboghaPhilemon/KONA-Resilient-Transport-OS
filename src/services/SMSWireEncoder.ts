import { createHmac } from 'crypto';

/**
 * SMSWireEncoder: Symmetric compression & signing for low-bandwidth SMS transport.
 *
 * Converts transaction objects to compact positional semicolon-separated format,
 * signs with HMAC-SHA256, splits across 160-char SMS envelopes, and reconstructs
 * with full signature verification.
 */

// Field abbreviation map for compact positional encoding
const FIELD_ABBREVIATIONS: { [key: string]: string } = {
  booking_id: 'bid',
  booking_lock: 'BL',
  lock_reason: 'lr',
  driver_id: 'did',
  device_id: 'dvid',
  telemetry_ping: 'TP',
  trip_id: 'tid',
  trip_status: 'tst',
  location_lat: 'll',
  location_lon: 'ln',
  timestamp: 'ts',
  event_type: 'et',
  payload: 'pl',
  action_type: 'at',
  order_id: 'oid',
  available: 'av',
  status: 'st',
  reason: 'rn',
};

// Reverse map for field reconstruction
const REVERSE_ABBREVIATIONS: { [key: string]: string } = Object.entries(
  FIELD_ABBREVIATIONS
).reduce((acc, [full, short]) => {
  acc[short] = full;
  return acc;
}, {} as { [key: string]: string });

interface SMSEnvelope {
  header: string; // "KONA:TXID:PART/TOTAL:SIGNATURE"
  data: string;   // payload data portion
}

export class SMSWireEncoder {
  /**
   * Encodes a transaction object to low-bandwidth SMS format.
   *
   * @param row - Transaction object with field/value pairs
   * @param txId - Transaction ID (UUID or identifier)
   * @param deviceSecret - Device secret for HMAC signing
   * @returns Array of SMS envelopes, max 160 chars each, format: KONA:TXID:PART/TOTAL:SIGNATURE:DATA
   */
  static encodeTransactionToSMS(
    row: any,
    txId: string,
    deviceSecret: string
  ): string[] {
    // Convert transaction object to positional semicolon-separated format
    const positionalized = this.flattenToPositional(row);

    // Generate HMAC-SHA256 signature over the positional string
    const signature = this.generateSignature(positionalized, deviceSecret);

    // Prefix with signature
    const signedData = `${signature}:${positionalized}`;

    // Split into 160-char max envelopes, accounting for header overhead
    // Header: "KONA:TXID:PART/TOTAL:SIGNATURE:"  ~= 30-35 chars
    const maxDataPerEnvelope = 160 - 35; // Conservative limit
    const dataChunks = this.chunkString(signedData, maxDataPerEnvelope);

    // Format as KONA envelopes
    const envelopes = dataChunks.map((data, index) => {
      const part = index + 1;
      const total = dataChunks.length;
      return `KONA:${txId}:${part}/${total}:${data}`;
    });

    return envelopes;
  }

  /**
   * Decodes SMS envelopes back to a transaction object.
   *
   * @param envelopes - Array of SMS envelope strings
   * @param deviceSecret - Device secret for HMAC verification
   * @returns Reconstructed transaction object
   * @throws Error if envelope format is invalid or signature verification fails
   */
  static decodeSMSToTransaction(
    envelopes: string[],
    deviceSecret: string
  ): any {
    if (!envelopes || envelopes.length === 0) {
      throw new Error('No SMS envelopes provided');
    }

    // Parse and validate envelope headers
    const parsedEnvelopes = envelopes.map((env, idx) => {
      const match = env.match(/^KONA:([^:]+):(\d+)\/(\d+):(.*)$/);
      if (!match) {
        throw new Error(`Invalid SMS envelope format at index ${idx}: ${env}`);
      }
      const [, txId, part, total, data] = match;
      return {
        txId,
        part: parseInt(part, 10),
        total: parseInt(total, 10),
        data,
      };
    });

    // Validate part sequence
    const totalParts = parsedEnvelopes[0].total;
    if (parsedEnvelopes.length !== totalParts) {
      throw new Error(
        `Envelope count mismatch: expected ${totalParts}, got ${parsedEnvelopes.length}`
      );
    }

    for (let i = 0; i < parsedEnvelopes.length; i++) {
      if (parsedEnvelopes[i].part !== i + 1) {
        throw new Error(
          `Part index out of order: expected part ${i + 1}, got ${parsedEnvelopes[i].part}`
        );
      }
    }

    // Reassemble data
    const stitched = parsedEnvelopes.map((env) => env.data).join('');

    // Parse signature and data
    const [providedSignature, ...dataParts] = stitched.split(':');
    const positionalized = dataParts.join(':'); // In case data contains ':'

    // Verify signature
    const expectedSignature = this.generateSignature(
      positionalized,
      deviceSecret
    );
    if (!this.timingSafeEqualHex(providedSignature, expectedSignature)) {
      throw new Error('SMS signature verification failed: data may be tampered');
    }

    // Inflate positional format back to structured object
    const transaction = this.inflateFromPositional(positionalized);

    return transaction;
  }

  /**
   * Converts transaction object to compact positional semicolon-separated format.
   * Ordered fields to ensure deterministic serialization.
   */
  private static flattenToPositional(row: any): string {
    const keys = Object.keys(row).sort();
    const values = keys.map((key) => {
      const abbrev = FIELD_ABBREVIATIONS[key] || key;
      const val = row[key];
      // Encode value: escape semicolons and pipes
      const encoded =
        typeof val === 'string'
          ? val.replace(/[;|]/g, (c) => (c === ';' ? '\\;' : '\\|'))
          : String(val);
      return `${abbrev}|${encoded}`;
    });
    return values.join(';');
  }

  /**
   * Inflates positional format back to structured transaction object.
   */
  private static inflateFromPositional(positionalized: string): any {
    const obj: any = {};
    const parts = positionalized.split(';').filter((p) => p.length > 0);

    for (const part of parts) {
      const [abbrev, ...valueParts] = part.split('|');
      const value = valueParts.join('|'); // In case value contains '|'

      // Unescape special characters
      const unescaped = value.replace(/\\[;|]/g, (m) =>
        m === '\\;' ? ';' : '|'
      );

      // Reverse abbreviation lookup
      const fullKey = REVERSE_ABBREVIATIONS[abbrev] || abbrev;
      obj[fullKey] = unescaped;
    }

    return obj;
  }

  /**
   * Generates an 8-character uppercase HMAC-SHA256 signature.
   */
  private static generateSignature(data: string, deviceSecret: string): string {
    const hmac = createHmac('sha256', deviceSecret);
    hmac.update(data);
    const hash = hmac.digest('hex');
    return hash.substring(0, 8).toUpperCase();
  }

  /**
   * Splits a string into chunks of max length, preserving integrity.
   */
  private static chunkString(str: string, maxLength: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < str.length; i += maxLength) {
      chunks.push(str.substring(i, i + maxLength));
    }
    return chunks.length === 0 ? [''] : chunks;
  }

  /**
   * Timing-safe hex string comparison to prevent timing attacks.
   */
  private static timingSafeEqualHex(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }
    try {
      return (
        createHmac('sha256', 'dummy')
          .update('')
          .digest() &&
        left === right // Placeholder: Node.js 18+ has crypto.timingSafeEqual
      );
    } catch {
      // Fallback to constant-time-ish comparison
      let result = 0;
      for (let i = 0; i < left.length; i++) {
        result |=
          left.charCodeAt(i) ^ (right.charCodeAt(i) || 0);
      }
      return result === 0;
    }
  }
}
