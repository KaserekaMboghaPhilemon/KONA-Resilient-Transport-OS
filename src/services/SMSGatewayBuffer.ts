import { SMSReassemblyManager } from "./SMSReassemblyManager";

export type SMSGatewayProvider = "africas_talking" | "twilio" | "native";

export interface SMSGatewaySegment {
  sender: string;
  body: string;
  messageId?: string;
  provider: SMSGatewayProvider;
  tenantId?: string;
}

export class SMSGatewayBuffer {
  public static async ingestIncomingSegment(
    segment: SMSGatewaySegment,
  ): Promise<Record<string, unknown> | null> {
    return SMSReassemblyManager.processIncomingSegment(
      segment.sender,
      segment.body,
    );
  }
}
