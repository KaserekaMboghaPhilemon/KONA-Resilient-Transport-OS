/**
 * SMS Intake Route – POST /api/v1/sms/gateway-webhook
 *
 * Receives inbound SMS segments forwarded by a telecom gateway (Africa's
 * Talking, Twilio, or any compatible provider) and feeds them into the
 * SMSReassemblyManager accumulation pipeline.
 *
 * Request body (application/x-www-form-urlencoded or application/json):
 *
 *   Africa's Talking format:
 *     { from: "+254700000001", text: "KONA:ABCD:1/2:…" }
 *
 *   Twilio format:
 *     { From: "+254700000001", Body: "KONA:ABCD:1/2:…" }
 *
 * The handler normalises both field-name casings so either gateway works
 * without upstream configuration changes.
 *
 * Response contract:
 *   200 OK       – Payload fully reassembled; ledger pipeline triggered.
 *   202 Accepted – Segment stored; still waiting for remaining frames.
 *   400 Bad Request – Missing or empty From / Body fields.
 *   500 Internal Server Error – Unexpected processing failure.
 *
 * Security notes:
 *   – This handler trusts gateway-supplied sender numbers. Production
 *     deployments MUST add request-signature validation middleware
 *     (e.g. Twilio's X-Twilio-Signature or AT's HMAC header) before
 *     mounting this router on a public interface.
 *   – Body size limits should be enforced by the parent express.json()
 *     and express.urlencoded() middleware to prevent oversized payloads.
 */

import { Router, Request, Response } from 'express';
import { SMSReassemblyManager } from '../services/SMSReassemblyManager';
import { SyncController } from '../controllers/SyncController';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * Expected fields in the parsed request body.
 * Both Africa's Talking and Twilio field-name conventions are supported:
 *
 *   Africa's Talking: { from, text }
 *   Twilio:           { From, Body }
 */
interface GatewayWebhookBody {
  // Africa's Talking field names (lowercase)
  from?: string;
  text?: string;
  // Twilio field names (title-case)
  From?: string;
  Body?: string;
}

/**
 * Structured JSON shape returned in every webhook response body.
 */
interface WebhookResponse {
  status: 'ok' | 'accepted' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

/**
 * POST /api/v1/sms/gateway-webhook
 *
 * Accepts a single inbound SMS segment from the telecom gateway, accumulates
 * it in SMSReassemblyManager, and triggers the ledger pipeline when all
 * segments of a multi-frame transmission have arrived.
 */
router.post(
  '/gateway-webhook',
  async (req: Request<unknown, WebhookResponse, GatewayWebhookBody>, res: Response<WebhookResponse>): Promise<void> => {
    try {
      const body = req.body as GatewayWebhookBody;

      // ── Field extraction ────────────────────────────────────────────────
      // Accept both Africa's Talking (lowercase) and Twilio (title-case)
      // field conventions; prefer lowercase when both are present.
      const sender: string | undefined =
        (body.from ?? body.From ?? '').trim() || undefined;

      const rawBody: string | undefined =
        (body.text ?? body.Body ?? '').trim() || undefined;

      // ── Input validation ────────────────────────────────────────────────
      if (!sender) {
        res.status(400).json({
          status: 'error',
          message: 'Missing required field: "From" (sender phone number).',
        });
        return;
      }

      if (!rawBody) {
        res.status(400).json({
          status: 'error',
          message: 'Missing required field: "Body" (SMS message content).',
        });
        return;
      }

      // ── Reassembly pipeline ─────────────────────────────────────────────
      const payload = await SMSReassemblyManager.processIncomingSegment(
        sender,
        rawBody,
      );

      // ── Response dispatch ───────────────────────────────────────────────
      if (payload !== null) {
        // All segments received — payload fully decoded. Trigger ledger pipeline.
        await SyncController.executeAction(payload);

        res.status(200).json({
          status: 'ok',
          message: 'Payload reassembled and dispatched to the ledger pipeline.',
        });
        return;
      }

      // Segment stored; still waiting for more frames from this transmission.
      res.status(202).json({
        status: 'accepted',
        message: 'SMS segment accepted. Awaiting remaining frames.',
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred.';

      console.error('[smsIntake] Unhandled error in gateway-webhook handler:', err);

      res.status(500).json({
        status: 'error',
        message,
      });
    }
  },
);

export default router;
