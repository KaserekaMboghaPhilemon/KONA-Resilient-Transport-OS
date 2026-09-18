import type { PeerNode, P2PFrame } from "../types/p2p";

export type P2PFrameListener = (frame: P2PFrame) => void;

export class BluetoothMeshManager {
  private readonly peers = new Map<string, PeerNode>();
  private readonly listeners = new Set<P2PFrameListener>();

  public registerPeer(peer: PeerNode): void {
    this.peers.set(peer.peerId, peer);
  }

  public removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  public getPeer(peerId: string): PeerNode | undefined {
    return this.peers.get(peerId);
  }

  public listPeers(): PeerNode[] {
    return [...this.peers.values()];
  }

  public subscribe(listener: P2PFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async broadcastFrame(frame: P2PFrame): Promise<number> {
    const connectedPeers = [...this.peers.values()].filter(
      (peer) =>
        peer.status === "CONNECTED" && peer.peerId !== frame.senderPeerId,
    );
    let delivered = 0;

    for (const peer of connectedPeers) {
      if (!peer.sendFrame) {
        continue;
      }

      try {
        if (await peer.sendFrame(frame)) {
          delivered += 1;
        }
      } catch (error) {
        console.warn(
          `[BluetoothMeshManager] Delivery to ${peer.peerId} failed.`,
          error,
        );
      }
    }

    return delivered;
  }

  public handleIncomingFrame(rawPayload: string): void {
    try {
      const parsed: unknown = JSON.parse(rawPayload);
      if (!this.isP2PFrame(parsed)) {
        console.warn("[BluetoothMeshManager] Ignoring malformed P2P frame.");
        return;
      }

      for (const listener of this.listeners) {
        try {
          listener(parsed);
        } catch (error) {
          console.warn("[BluetoothMeshManager] Frame listener failed.", error);
        }
      }
    } catch (error) {
      console.warn(
        "[BluetoothMeshManager] Ignoring invalid JSON payload.",
        error,
      );
    }
  }

  private isP2PFrame(value: unknown): value is P2PFrame {
    if (!value || typeof value !== "object") return false;
    const frame = value as Record<string, unknown>;
    return (
      typeof frame.type === "string" &&
      ["HANDSHAKE", "DELTA_REQUEST", "DELTA_RESPONSE", "SOS"].includes(
        frame.type,
      ) &&
      typeof frame.senderPeerId === "string" &&
      typeof frame.sentAt === "number" &&
      typeof frame.payload === "object" &&
      frame.payload !== null
    );
  }
}
