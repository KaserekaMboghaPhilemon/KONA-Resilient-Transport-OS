export type P2PMessageType =
  | "HANDSHAKE"
  | "DELTA_REQUEST"
  | "DELTA_RESPONSE"
  | "SOS";

export type PeerConnectionStatus = "DISCOVERED" | "CONNECTED" | "DISCONNECTED";

export interface PeerNode {
  peerId: string;
  status: PeerConnectionStatus;
  ledgerHead: number;
  lastSeenAt: number;
  sendFrame?: (frame: P2PFrame) => Promise<boolean>;
}

export interface SyncHandshakePayload {
  [key: string]: unknown;
  peerId: string;
  ledgerHead: number;
  protocolVersion: string;
}

export interface EmergencyPacket {
  [key: string]: unknown;
  eventId: string;
  originPeerId: string;
  message: string;
  ttl: number;
  createdAt: number;
}

export interface P2PFrame {
  type: P2PMessageType;
  senderPeerId: string;
  recipientPeerId?: string;
  payload: SyncHandshakePayload | EmergencyPacket | Record<string, unknown>;
  sentAt: number;
}
