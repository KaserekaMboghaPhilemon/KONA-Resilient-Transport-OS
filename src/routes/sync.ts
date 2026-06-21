import { Request, Response, Router } from 'express';
import {
  OfflineLedgerVerificationError,
  OfflineLedgerBatchInput,
  SignatureAuthenticationError,
  SyncController,
} from '../controllers/SyncController';

interface SyncIngestResponse {
  status: 'ok' | 'error';
  message: string;
  acceptedRows?: number;
  breachType?: string;
  failedRowId?: number;
}

const router = Router();

router.post(
  '/offline-batch',
  async (
    req: Request<unknown, SyncIngestResponse, OfflineLedgerBatchInput>,
    res: Response<SyncIngestResponse>,
  ): Promise<void> => {
    try {
      const result = await SyncController.ingestOfflineLedgerBatch(req.body);
      res.status(200).json({
        status: 'ok',
        message: 'Offline batch reconciled and committed successfully.',
        acceptedRows: result.acceptedRows,
      });
      return;
    } catch (error) {
      if (error instanceof OfflineLedgerVerificationError) {
        res.status(400).json({
          status: 'error',
          message: 'Offline ledger verification failed. Driver profile flagged SUSPENDED_AUDIT.',
          breachType: error.breachType,
          failedRowId: error.failedRowId,
        });
        return;
      }

      if (error instanceof SignatureAuthenticationError) {
        res.status(401).json({
          status: 'error',
          message: error.message,
        });
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unexpected sync ingestion error.';
      res.status(500).json({
        status: 'error',
        message,
      });
    }
  },
);

export default router;
