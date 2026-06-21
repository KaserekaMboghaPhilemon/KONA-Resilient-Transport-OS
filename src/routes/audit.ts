import { Router, Request, Response } from 'express';
import { ServerLedgerReconciler } from '../services/ServerLedgerReconciler';

interface ClearLockBody {
  deviceId?: string;
  nonce?: number;
  adminSignatureHex?: string;
}

interface ClearLockResponse {
  status: 'ok' | 'error';
  message: string;
  sweepToken?: string;
}

const router = Router();

router.post(
  '/clear-lock',
  async (
    req: Request<unknown, ClearLockResponse, ClearLockBody>,
    res: Response<ClearLockResponse>,
  ): Promise<void> => {
    const adminSecret = process.env.KONA_ADMIN_SWEEP_SECRET;
    if (!adminSecret) {
      res.status(500).json({
        status: 'error',
        message: 'Server missing KONA_ADMIN_SWEEP_SECRET configuration.',
      });
      return;
    }

    const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
    const nonce = Number(req.body.nonce);
    const signature =
      typeof req.body.adminSignatureHex === 'string'
        ? req.body.adminSignatureHex.trim()
        : '';

    if (!deviceId || !Number.isInteger(nonce) || nonce < 0 || !signature) {
      res.status(400).json({
        status: 'error',
        message: 'Invalid request body. Required: deviceId, nonce, adminSignatureHex.',
      });
      return;
    }

    const signatureOk = ServerLedgerReconciler.verifyAdminSweepSignature(
      adminSecret,
      deviceId,
      nonce,
      signature,
    );

    if (!signatureOk) {
      res.status(401).json({
        status: 'error',
        message: 'Invalid administrative audit signature.',
      });
      return;
    }

    const sweepToken = ServerLedgerReconciler.generateAdminSweepToken(
      adminSecret,
      deviceId,
      nonce,
    );

    res.status(200).json({
      status: 'ok',
      message: 'Remote sweep token generated.',
      sweepToken,
    });
  },
);

export default router;
