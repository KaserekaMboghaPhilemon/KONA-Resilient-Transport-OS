import type { P2PFrame } from "../../types/p2p";
import { BluetoothMeshManager } from "../BluetoothMeshManager";
import { OfflineEmergencyDispatcher } from "../OfflineEmergencyDispatcher";
import {
  P2PSyncEngine,
  type P2PLedgerAdapter,
  type RemoteLedgerRow,
} from "../P2PSyncEngine";

function connectedPeer(
  peerId: string,
  sendFrame: (frame: P2PFrame) => Promise<boolean>,
) {
  return {
    peerId,
    status: "CONNECTED" as const,
    ledgerHead: 0,
    lastSeenAt: Date.now(),
    sendFrame,
  };
}

describe("Sprint 19 - P2P mesh synchronization and emergency dispatch", () => {
  it("requests the missing ledger range from a peer handshake", async () => {
    const mesh = new BluetoothMeshManager();
    const sent: P2PFrame[] = [];
    mesh.registerPeer(
      connectedPeer("peer-b", async (frame) => {
        sent.push(frame);
        return true;
      }),
    );
    const ledger: P2PLedgerAdapter = {
      getLocalLedgerHead: async () => 3,
      getRows: async () => [],
      verifyAndInsertRemoteRow: async () => undefined,
    };
    const engine = new P2PSyncEngine("peer-a", mesh, ledger);

    await engine.handleIncomingFrame({
      type: "HANDSHAKE",
      senderPeerId: "peer-b",
      sentAt: Date.now(),
      payload: { peerId: "peer-b", ledgerHead: 5, protocolVersion: "1.0" },
    });

    expect(sent[0].type).toBe("DELTA_REQUEST");
    expect(sent[0].payload).toEqual({ startId: 4, endId: 5 });
    engine.dispose();
  });

  it("verifies and inserts delta rows sequentially", async () => {
    const mesh = new BluetoothMeshManager();
    const inserted: number[] = [];
    const rows: RemoteLedgerRow[] = [1, 2].map((id) => ({
      id,
      payload: `row-${id}`,
      previous_row_hash: `prev-${id}`,
      row_signature: `sig-${id}`,
    }));
    const ledger: P2PLedgerAdapter = {
      getLocalLedgerHead: async () => 0,
      getRows: async () => rows,
      verifyAndInsertRemoteRow: async (row) => {
        inserted.push(row.id);
      },
    };
    const engine = new P2PSyncEngine("peer-a", mesh, ledger);

    await engine.handleIncomingFrame({
      type: "DELTA_RESPONSE",
      senderPeerId: "peer-b",
      sentAt: Date.now(),
      payload: { rows: [rows[1], rows[0]] },
    });

    expect(inserted).toEqual([1, 2]);
    engine.dispose();
  });

  it("suppresses duplicate SOS events and decrements relayed TTL", async () => {
    const mesh = new BluetoothMeshManager();
    const relayed: P2PFrame[] = [];
    mesh.registerPeer(
      connectedPeer("peer-b", async (frame) => {
        relayed.push(frame);
        return true;
      }),
    );
    const dispatcher = new OfflineEmergencyDispatcher("peer-a", mesh);
    const frame: P2PFrame = {
      type: "SOS",
      senderPeerId: "peer-origin",
      sentAt: Date.now(),
      payload: {
        eventId: "sos-1",
        originPeerId: "peer-origin",
        message: "help",
        ttl: 2,
        createdAt: Date.now(),
      },
    };

    mesh.handleIncomingFrame(JSON.stringify(frame));
    mesh.handleIncomingFrame(JSON.stringify(frame));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(relayed).toHaveLength(1);
    expect(relayed[0].payload).toMatchObject({ eventId: "sos-1", ttl: 1 });
    expect(dispatcher.hasSeenEvent("sos-1")).toBe(true);
    dispatcher.dispose();
  });

  it("drops SOS packets with zero TTL", async () => {
    const mesh = new BluetoothMeshManager();
    const sendFrame = jest.fn(async () => true);
    mesh.registerPeer(connectedPeer("peer-b", sendFrame));
    const dispatcher = new OfflineEmergencyDispatcher("peer-a", mesh);

    mesh.handleIncomingFrame(
      JSON.stringify({
        type: "SOS",
        senderPeerId: "peer-origin",
        sentAt: Date.now(),
        payload: {
          eventId: "sos-expired",
          originPeerId: "peer-origin",
          message: "expired",
          ttl: 0,
          createdAt: Date.now(),
        },
      } satisfies P2PFrame),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendFrame).not.toHaveBeenCalled();
    dispatcher.dispose();
  });
});
