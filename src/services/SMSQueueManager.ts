export interface QueuedSMSPdu {
  rawPdu: string;
  receivedAt: number;
}

export class SMSQueueManager {
  private static queuedPdus: QueuedSMSPdu[] = [];

  public static enqueueRawPdu(rawPdu: string): QueuedSMSPdu {
    const normalizedPdu = rawPdu.trim();
    if (!normalizedPdu) {
      throw new TypeError(
        "[SMSQueueManager] rawPdu must be a non-empty string.",
      );
    }

    const entry = { rawPdu: normalizedPdu, receivedAt: Date.now() };
    this.queuedPdus.push(entry);
    return entry;
  }

  public static getQueuedPdus(): QueuedSMSPdu[] {
    return [...this.queuedPdus];
  }

  public static clear(): void {
    this.queuedPdus = [];
  }
}
