import { createHmac } from 'crypto';

import { CryptoSignatureEngine } from '../CryptoSignatureEngine';

describe('CryptoSignatureEngine', () => {
  it('returns deterministic signatures for identical payload and secret', async () => {
    const payload = 'TRIP_1|1.23,4.56,20,1700000000';
    const secret = 'DEVICE_SECRET_ABC';

    const sig1 = await CryptoSignatureEngine.generateSignature(payload, secret);
    const sig2 = await CryptoSignatureEngine.generateSignature(payload, secret);

    expect(sig1).toBe(sig2);
  });

  it('returns an uppercase 8-char hex signature', async () => {
    const signature = await CryptoSignatureEngine.generateSignature('payload', 'secret');

    expect(signature).toHaveLength(8);
    expect(signature).toMatch(/^[A-F0-9]{8}$/);
  });

  it('throws when secret key is missing', async () => {
    await expect(CryptoSignatureEngine.generateSignature('payload', '')).rejects.toThrow(
      '[CryptoEngine] Cannot sign payload: Missing secret authentication key.',
    );
  });

  it('verifies a matching signature as true', async () => {
    const payload = 'KONA_SAMPLE_PAYLOAD';
    const secret = 'MY_SECRET';
    const signature = await CryptoSignatureEngine.generateSignature(payload, secret);

    const ok = await CryptoSignatureEngine.verifySignature(payload, signature, secret);

    expect(ok).toBe(true);
  });

  it('rejects signature verification with an incorrect secret key', async () => {
    const payload = 'KONA_SAMPLE_PAYLOAD';
    const validSecret = 'RIGHT_SECRET';
    const wrongSecret = 'WRONG_SECRET';
    const signature = await CryptoSignatureEngine.generateSignature(payload, validSecret);

    const ok = await CryptoSignatureEngine.verifySignature(payload, signature, wrongSecret);

    expect(ok).toBe(false);
  });

  it('matches Node crypto.createHmac output truncation exactly', async () => {
    const payload = 'TRIP_SECURE_WIRE_PAYLOAD';
    const secret = 'HMAC_SECRET_123';

    const expected = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();

    const actual = await CryptoSignatureEngine.generateSignature(payload, secret);

    expect(actual).toBe(expected);
  });
});
