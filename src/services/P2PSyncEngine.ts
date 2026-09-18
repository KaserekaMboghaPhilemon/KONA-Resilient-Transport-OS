import type { P2PFrame, SyncHandshakePayload } from "../types/p2p";
import { BluetoothMeshManager } from "./BluetoothMeshManager";

export interface RemoteLedgerRow {
  id: number;
  payload: string;
  previous_row_hash: string;
  row_signature: string;
}

export interface P2PLedgerAdapter {
  getLocalLedgerHead(): Promise<number>;
  getRows(startId: number, endId: number): Promise<RemoteLedgerRow[]>;
  verifyAndInsertRemoteRow(row: RemoteLedgerRow): Promise<void>;
}

interface DeltaRequestPayload {
  [key: string]: unknown;
  startId: number;
  endId: number;
}

interface DeltaResponsePayload {
  [key: string]: unknown;
  rows: RemoteLedgerRow[];
}

export class P2PSyncEngine {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly peerId: string,
    private readonly mesh: BluetoothMeshManager,
    private readonly ledgerGuard: P2PLedgerAdapter,
  ) {
    this.unsubscribe = mesh.subscribe((frame) => {
      void this.handleIncomingFrame(frame);
    });
  }

  public dispose(): void {
    this.unsubscribe();
  }

  public async createHandshake(): Promise<P2PFrame> {
    const ledgerHead = await this.ledgerGuard.getLocalLedgerHead();
    const payload: SyncHandshakePayload = {
      peerId: this.peerId,
      ledgerHead,
      protocolVersion: "1.0",
    };
    return this.createFrame("HANDSHAKE", payload);
  }

  public async synchronizeWithPeer(peerId: string): Promise<number> {
    const frame = await this.createHandshake();
    frame.recipientPeerId = peerId;
    return this.mesh.broadcastFrame(frame);
  }

  public async handleIncomingFrame(frame: P2PFrame): Promise<void> {
    if (frame.recipientPeerId && frame.recipientPeerId !== this.peerId) return;

    try {
      if (frame.type === "HANDSHAKE") {
        await this.handleHandshake(frame);
      } else if (frame.type === "DELTA_REQUEST") {
        await this.handleDeltaRequest(frame);
      } else if (frame.type === "DELTA_RESPONSE") {
        await this.handleDeltaResponse(frame);
      }
    } catch (error) {
      console.warn(
        `[P2PSyncEngine] Failed to process ${frame.type} frame.`,
        error,
      );
    }
  }

  private async handleHandshake(frame: P2PFrame): Promise<void> {
    const payload = this.asHandshake(frame.payload);
    if (!payload) return;

    const localHead = await this.ledgerGuard.getLocalLedgerHead();
    if (payload.ledgerHead <= localHead) return;

    const request: DeltaRequestPayload = {
      startId: localHead + 1,
      endId: payload.ledgerHead,
    };
    await this.send(frame.senderPeerId, "DELTA_REQUEST", request);
  }

  private async handleDeltaRequest(frame: P2PFrame): Promise<void> {
    const request = this.asDeltaRequest(frame.payload);
    if (!request || request.startId > request.endId) return;

    const rows = await this.ledgerGuard.getRows(request.startId, request.endId);
    await this.send(frame.senderPeerId, "DELTA_RESPONSE", { rows });
  }

  private async handleDeltaResponse(frame: P2PFrame): Promise<void> {
    const response = this.asDeltaResponse(frame.payload);
    if (!response) return;

    const rows = [...response.rows].sort((left, right) => left.id - right.id);
    for (const row of rows) {
      await this.ledgerGuard.verifyAndInsertRemoteRow(row);
    }
  }

  private async send(
    recipientPeerId: string,
    type: P2PFrame["type"],
    payload: P2PFrame["payload"],
  ): Promise<void> {
    await this.mesh.broadcastFrame({
      type,
      senderPeerId: this.peerId,
      recipientPeerId,
      payload,
      sentAt: Date.now(),
    });
  }

  private createFrame(
    type: P2PFrame["type"],
    payload: P2PFrame["payload"],
  ): P2PFrame {
    return { type, senderPeerId: this.peerId, payload, sentAt: Date.now() };
  }

  private asHandshake(
    payload: P2PFrame["payload"],
  ): SyncHandshakePayload | null {
    if (
      "peerId" in payload &&
      typeof payload.peerId === "string" &&
      typeof payload.ledgerHead === "number" &&
      typeof payload.protocolVersion === "string"
    )
      return payload as SyncHandshakePayload;
    return null;
  }

  private asDeltaRequest(
    payload: P2PFrame["payload"],
  ): DeltaRequestPayload | null {
    if (
      "startId" in payload &&
      "endId" in payload &&
      typeof payload.startId === "number" &&
      typeof payload.endId === "number"
    )
      return payload as DeltaRequestPayload;
    return null;
  }

  private asDeltaResponse(
    payload: P2PFrame["payload"],
  ): DeltaResponsePayload | null {
    if (!("rows" in payload) || !Array.isArray(payload.rows)) return null;
    return {
      rows: payload.rows.filter((row): row is RemoteLedgerRow =>
        this.isLedgerRow(row),
      ),
    };
  }

  private isLedgerRow(value: unknown): value is RemoteLedgerRow {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return (
      typeof row.id === "number" &&
      typeof row.payload === "string" &&
      typeof row.previous_row_hash === "string" &&
      typeof row.row_signature === "string"
    );
  }
}
