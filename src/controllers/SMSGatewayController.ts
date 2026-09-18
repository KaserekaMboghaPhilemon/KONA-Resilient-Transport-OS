import {
  SMSGatewayBuffer,
  type SMSGatewayProvider,
  type SMSGatewaySegment,
} from "../services/SMSGatewayBuffer";

export interface AfricaTalkingSMSPayload {
  from?: unknown;
  text?: unknown;
  id?: unknown;
  tenantId?: unknown;
}

export interface TwilioSMSPayload {
  From?: unknown;
  Body?: unknown;
  MessageSid?: unknown;
  AccountSid?: unknown;
}

export type SMSGatewayPayload = AfricaTalkingSMSPayload | TwilioSMSPayload;

export class SMSGatewayController {
  public static normalizePayload(
    payload: SMSGatewayPayload,
  ): SMSGatewaySegment {
    const africaTalking = this.isAfricaTalkingPayload(payload);
    const sender = this.readString(africaTalking ? payload.from : payload.From);
    const body = this.readString(africaTalking ? payload.text : payload.Body);
    const messageId = this.readOptionalString(
      africaTalking ? payload.id : payload.MessageSid,
    );

    if (!sender || !body) {
      throw new TypeError(
        "[SMSGatewayController] Payload requires a sender and message body.",
      );
    }

    return {
      sender,
      body,
      messageId,
      provider: africaTalking ? "africas_talking" : "twilio",
      tenantId: africaTalking
        ? this.readOptionalString(payload.tenantId)
        : this.readOptionalString(payload.AccountSid),
    };
  }

  public static async ingestPayload(
    payload: SMSGatewayPayload,
  ): Promise<Record<string, unknown> | null> {
    return SMSGatewayBuffer.ingestIncomingSegment(
      this.normalizePayload(payload),
    );
  }

  private static isAfricaTalkingPayload(
    payload: SMSGatewayPayload,
  ): payload is AfricaTalkingSMSPayload {
    return "from" in payload || "text" in payload || "id" in payload;
  }

  private static readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private static readOptionalString(value: unknown): string | undefined {
    const normalized = this.readString(value);
    return normalized || undefined;
  }
}

export type { SMSGatewayProvider };
