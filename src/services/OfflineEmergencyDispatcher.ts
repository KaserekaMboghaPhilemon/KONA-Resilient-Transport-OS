import type { EmergencyPacket, P2PFrame } from "../types/p2p";
import { BluetoothMeshManager } from "./BluetoothMeshManager";

export class OfflineEmergencyDispatcher {
  private readonly seenEventIds = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly peerId: string,
    private readonly mesh: BluetoothMeshManager,
  ) {
    this.unsubscribe = mesh.subscribe((frame) => {
      if (frame.type === "SOS") void this.handleIncomingSOS(frame);
    });
  }

  public dispose(): void {
    this.unsubscribe();
  }

  public async dispatchSOS(
    message: string,
    ttl: number,
    eventId: string,
  ): Promise<number> {
    if (ttl <= 0 || this.seenEventIds.has(eventId)) return 0;
    this.seenEventIds.add(eventId);
    return this.mesh.broadcastFrame(
      this.createSOSFrame({
        eventId,
        originPeerId: this.peerId,
        message,
        ttl,
        createdAt: Date.now(),
      }),
    );
  }

  public hasSeenEvent(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  private async handleIncomingSOS(frame: P2PFrame): Promise<void> {
    const packet = this.asEmergencyPacket(frame.payload);
    if (!packet || packet.ttl <= 0 || this.seenEventIds.has(packet.eventId))
      return;

    this.seenEventIds.add(packet.eventId);
    if (packet.ttl <= 1) return;

    await this.mesh.broadcastFrame(
      this.createSOSFrame({ ...packet, ttl: packet.ttl - 1 }),
    );
  }

  private createSOSFrame(payload: EmergencyPacket): P2PFrame {
    return {
      type: "SOS",
      senderPeerId: this.peerId,
      payload,
      sentAt: Date.now(),
    };
  }

  private asEmergencyPacket(
    payload: P2PFrame["payload"],
  ): EmergencyPacket | null {
    if (
      "eventId" in payload &&
      typeof payload.eventId === "string" &&
      "originPeerId" in payload &&
      typeof payload.originPeerId === "string" &&
      "message" in payload &&
      typeof payload.message === "string" &&
      "ttl" in payload &&
      typeof payload.ttl === "number" &&
      "createdAt" in payload &&
      typeof payload.createdAt === "number"
    )
      return payload as EmergencyPacket;
    return null;
  }
}
