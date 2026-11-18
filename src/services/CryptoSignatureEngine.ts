import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Sprint 11 - Compact symmetric HMAC engine for SMS payload integrity.
 */
export class CryptoSignatureEngine {
  private static readonly SIGNATURE_LEN = 8;

  /**
   * Generates a truncated 8-character uppercase HMAC-SHA256 signature.
   */
  public static async generateSignature(payload: string, secretKey: string): Promise<string> {
    const normalizedSecret = secretKey.trim();
    if (!normalizedSecret) {
      throw new Error('[CryptoEngine] Cannot sign payload: Missing secret authentication key.');
    }

    const fullDigest = createHmac('sha256', normalizedSecret)
      .update(payload)
      .digest('hex');

    return fullDigest.slice(0, this.SIGNATURE_LEN).toUpperCase();
  }

  /**
   * Verifies an incoming signature against a locally computed signature.
   */
  public static async verifySignature(
    payload: string,
    incomingSignature: string,
    secretKey: string,
  ): Promise<boolean> {
    const computed = await this.generateSignature(payload, secretKey);
    return computed === incomingSignature.trim().toUpperCase();
  }

  public static async generateStrongSignature(payload: string, secretKey: string): Promise<string> {
    const normalizedSecret = secretKey.trim();
    if (!normalizedSecret) {
      throw new Error('[CryptoEngine] Cannot sign payload: Missing secret authentication key.');
    }

    return createHmac('sha256', normalizedSecret).update(payload).digest('hex');
  }

  public static async verifyStrongSignature(
    payload: string,
    incomingSignature: string,
    secretKey: string,
  ): Promise<boolean> {
    if (!/^[a-f\d]{64}$/i.test(incomingSignature)) {
      return false;
    }
    const expected = Buffer.from(await this.generateStrongSignature(payload, secretKey), 'hex');
    const received = Buffer.from(incomingSignature, 'hex');
    return timingSafeEqual(expected, received);
  }
}
