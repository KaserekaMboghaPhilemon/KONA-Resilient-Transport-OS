import crypto from 'crypto';
import express, { Application } from 'express';
import request from 'supertest';
import auditRouter from '../audit';

const ADMIN_SECRET = 'UNIT_TEST_AUDIT_ADMIN_SECRET';

function makeAdminSignature(deviceId: string, nonce: number): string {
  return crypto
    .createHmac('sha256', ADMIN_SECRET)
    .update(`AUTH_CLEAR_LOCK:${deviceId}:${nonce}`)
    .digest('hex');
}

describe('POST /api/v1/audit/clear-lock', () => {
  const app: Application = express();
  app.use(express.json());
  app.use('/api/v1/audit', auditRouter);

  beforeEach(() => {
    process.env.KONA_ADMIN_SWEEP_SECRET = ADMIN_SECRET;
  });

  afterEach(() => {
    delete process.env.KONA_ADMIN_SWEEP_SECRET;
  });

  it('returns 200 with sweep token when admin signature is valid', async () => {
    const deviceId = 'device-audit-01';
    const nonce = 445566;
    const adminSignatureHex = makeAdminSignature(deviceId, nonce);

    const res = await request(app)
      .post('/api/v1/audit/clear-lock')
      .send({ deviceId, nonce, adminSignatureHex });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.sweepToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns 401 when signature is invalid', async () => {
    const res = await request(app)
      .post('/api/v1/audit/clear-lock')
      .send({
        deviceId: 'device-audit-02',
        nonce: 1,
        adminSignatureHex: 'bad-signature',
      });

    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
  });

  it('returns 500 when server secret is missing', async () => {
    delete process.env.KONA_ADMIN_SWEEP_SECRET;

    const res = await request(app)
      .post('/api/v1/audit/clear-lock')
      .send({
        deviceId: 'device-audit-03',
        nonce: 7,
        adminSignatureHex: makeAdminSignature('device-audit-03', 7),
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
  });
});
