export interface TelemetryBatchBody {
  trip_id: string;
  payload_b45: string;
  point_count: number;
  idempotency_key: string;
}

export function telemetrySignaturePayload(body: TelemetryBatchBody): string {
  return `${body.trip_id}\n${body.point_count}\n${body.idempotency_key}\n${body.payload_b45}`;
}
