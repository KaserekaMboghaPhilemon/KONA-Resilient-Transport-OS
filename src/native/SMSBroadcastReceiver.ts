import { SMSQueueManager } from "../services/SMSQueueManager";

export interface AndroidSMSIntentExtras {
  pdus?: unknown;
}

export class SMSBroadcastReceiver {
  public static extractRawPdus(extras: AndroidSMSIntentExtras): string[] {
    if (!Array.isArray(extras.pdus)) {
      return [];
    }

    return extras.pdus.filter((pdu): pdu is string => typeof pdu === "string");
  }

  public static receive(extras: AndroidSMSIntentExtras): number {
    const pdus = this.extractRawPdus(extras);
    for (const rawPdu of pdus) {
      SMSQueueManager.enqueueRawPdu(rawPdu);
    }
    return pdus.length;
  }
}
