import { SMSGatewayController } from "../../controllers/SMSGatewayController";
import { SMSBroadcastReceiver } from "../../native/SMSBroadcastReceiver";
import { SMSQueueManager } from "../SMSQueueManager";
import { SMSGatewayBuffer } from "../SMSGatewayBuffer";

describe("Sprint 18 - Multi-tenant gateway and native receiver", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    SMSQueueManager.clear();
  });

  it("normalizes Africa's Talking JSON and ingests its segment", async () => {
    const ingest = jest
      .spyOn(SMSGatewayBuffer, "ingestIncomingSegment")
      .mockResolvedValue(null);

    await SMSGatewayController.ingestPayload({
      from: "+254700000001",
      text: "KONA:AT01:1/1:DATA",
      id: "at-message-1",
      tenantId: "tenant-at",
    });

    expect(ingest).toHaveBeenCalledWith({
      sender: "+254700000001",
      body: "KONA:AT01:1/1:DATA",
      messageId: "at-message-1",
      provider: "africas_talking",
      tenantId: "tenant-at",
    });
  });

  it("normalizes Twilio URL-encoded fields and ingests its segment", async () => {
    const ingest = jest
      .spyOn(SMSGatewayBuffer, "ingestIncomingSegment")
      .mockResolvedValue(null);

    await SMSGatewayController.ingestPayload({
      From: "+254700000002",
      Body: "KONA:TW01:1/1:DATA",
      MessageSid: "SM-message-1",
      AccountSid: "tenant-twilio",
    });

    expect(ingest).toHaveBeenCalledWith({
      sender: "+254700000002",
      body: "KONA:TW01:1/1:DATA",
      messageId: "SM-message-1",
      provider: "twilio",
      tenantId: "tenant-twilio",
    });
  });

  it("forwards native Android raw PDU strings directly into SMSQueueManager", () => {
    const enqueue = jest.spyOn(SMSQueueManager, "enqueueRawPdu");

    expect(
      SMSBroadcastReceiver.receive({ pdus: ["raw-pdu-1", "raw-pdu-2"] }),
    ).toBe(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, "raw-pdu-1");
    expect(enqueue).toHaveBeenNthCalledWith(2, "raw-pdu-2");
  });
});
