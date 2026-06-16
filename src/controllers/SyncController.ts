/**
 * SyncController – Core ledger pipeline entry point.
 *
 * Receives a fully-reassembled, decoded action payload that has arrived via
 * the SMS intake path and routes it into the KONA backend ledger pipeline.
 * This stub implementation logs the payload and returns a resolved promise;
 * swap the body of executeAction() for the real pipeline call when the
 * backend transport layer is wired.
 */

export interface LedgerActionPayload {
  /** Identifies the idempotent ledger action to execute. */
  action_type: string;
  /** Canonical order or entity identifier this action applies to. */
  order_id: string;
  /** Action-specific parameters; shape varies per action_type. */
  [key: string]: unknown;
}

export class SyncController {
  /**
   * Executes a ledger action from a fully-reassembled SMS payload.
   *
   * @param payload  Decoded JSON object produced by SMSReassemblyManager.
   * @returns        Resolved promise when the action has been accepted by the
   *                 pipeline. Throws on validation failure or pipeline error.
   * @throws {TypeError} When payload is missing required fields.
   */
  static async executeAction(payload: Record<string, unknown>): Promise<void> {
    // Validate required top-level fields before touching any downstream system.
    if (typeof payload['action_type'] !== 'string' || !payload['action_type']) {
      throw new TypeError(
        '[SyncController] executeAction: payload missing required field "action_type".',
      );
    }
    if (typeof payload['order_id'] !== 'string' || !payload['order_id']) {
      throw new TypeError(
        '[SyncController] executeAction: payload missing required field "order_id".',
      );
    }

    // TODO: replace with real pipeline invocation.
    console.log(
      `[SyncController] executeAction dispatching — action_type=${payload['action_type']} ` +
        `order_id=${payload['order_id']}`,
      payload,
    );
  }
}
