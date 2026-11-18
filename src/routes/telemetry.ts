import { Request, Response, Router } from 'express';
import { createHash } from 'node:crypto';
import base45 from 'base45';
import { knex } from '../database/knex';
import { DriverSecretRepository } from '../repositories/DriverSecretRepository';
import { CryptoSignatureEngine } from '../services/CryptoSignatureEngine';
import { telemetrySignaturePayload, type TelemetryBatchBody } from '../utils/TelemetryAuth';

interface TelemetryPointRow {
  trip_id: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  timestamp: number;
}

export const MAX_TELEMETRY_BATCH_POINTS = 10;
export const MAX_TELEMETRY_PAYLOAD_B45_LENGTH = 16_384;
const MAX_DECODED_TELEMETRY_BYTES = 8_192;
const MIN_TELEMETRY_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TELEMETRY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TELEMETRY_SPEED_METERS_PER_SECOND = 100;
const TRIP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE45_PATTERN = /^[0-9A-Z $%*+\-./:]+$/;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

export class TelemetryValidationError extends TypeError {}
export class TelemetryAuthenticationError extends Error {}
export class TelemetryPayloadTooLargeError extends Error {}
export class TelemetryConflictError extends Error {}

const router = Router();

function isTelemetryBatchBody(value: unknown): value is TelemetryBatchBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const body = value as Partial<TelemetryBatchBody>;
  return (
    typeof body.trip_id === 'string' &&
    typeof body.payload_b45 === 'string' &&
    typeof body.point_count === 'number' &&
    typeof body.idempotency_key === 'string'
  );
}

function decodeTelemetryPayload(body: TelemetryBatchBody): TelemetryPointRow[] {
  if (!TRIP_ID_PATTERN.test(body.trip_id)) {
    throw new TelemetryValidationError('trip_id must be a UUID.');
  }
  if (body.payload_b45.length > MAX_TELEMETRY_PAYLOAD_B45_LENGTH) {
    throw new TelemetryPayloadTooLargeError('Telemetry Base45 payload exceeds the size limit.');
  }
  if (
    body.payload_b45.length === 0 ||
    !BASE45_PATTERN.test(body.payload_b45) ||
    !/^[a-f\d]{64}$/i.test(body.idempotency_key) ||
    !Number.isInteger(body.point_count) ||
    body.point_count < 1 ||
    body.point_count > MAX_TELEMETRY_BATCH_POINTS
  ) {
    throw new TelemetryValidationError('Invalid telemetry batch envelope.');
  }

  let decodedBytes: Buffer;
  try {
    decodedBytes = base45.decode(body.payload_b45);
  } catch {
    throw new TelemetryValidationError('Telemetry payload is not valid Base45.');
  }
  if (
    decodedBytes.length > MAX_DECODED_TELEMETRY_BYTES ||
    !Buffer.from(decodedBytes.toString('utf8'), 'utf8').equals(decodedBytes)
  ) {
    throw new TelemetryPayloadTooLargeError('Decoded telemetry payload is invalid or too large.');
  }

  const decoded = decodedBytes.toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0 || decoded.slice(0, separator) !== body.trip_id) {
    throw new TelemetryValidationError('Telemetry payload trip_id mismatch.');
  }

  const pointStrings = decoded.slice(separator + 1).split(';');
  if (
    pointStrings.length !== body.point_count ||
    pointStrings.length > MAX_TELEMETRY_BATCH_POINTS
  ) {
    throw new TelemetryValidationError('Telemetry point count does not match the payload.');
  }

  const now = Date.now();
  return pointStrings.map((point): TelemetryPointRow => {
    const fields = point.split(',');
    if (fields.length !== 4) {
      throw new TelemetryValidationError('Telemetry point must contain four fields.');
    }

    const [latitudeText, longitudeText, speedText, timestampText] = fields;
    if (
      !DECIMAL_PATTERN.test(latitudeText) ||
      !DECIMAL_PATTERN.test(longitudeText) ||
      (speedText !== '' && !DECIMAL_PATTERN.test(speedText)) ||
      !/^\d+$/.test(timestampText)
    ) {
      throw new TelemetryValidationError('Telemetry point contains a malformed numeric field.');
    }

    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    const speed = speedText === '' ? null : Number(speedText);
    const timestamp = Number(timestampText);
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      (speed !== null &&
        (!Number.isFinite(speed) ||
          speed < 0 ||
          speed > MAX_TELEMETRY_SPEED_METERS_PER_SECOND)) ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < MIN_TELEMETRY_TIMESTAMP_MS ||
      timestamp > now + MAX_TELEMETRY_FUTURE_SKEW_MS
    ) {
      throw new TelemetryValidationError('Telemetry point is outside accepted bounds.');
    }
    return { trip_id: body.trip_id, latitude, longitude, speed, timestamp };
  });
}

export async function storeTelemetryBatch(
  body: TelemetryBatchBody,
  authenticatedDriverId: string,
): Promise<number> {
  if (!isTelemetryBatchBody(body)) {
    throw new TelemetryValidationError('Invalid telemetry batch envelope.');
  }
  const driverId = authenticatedDriverId.trim();
  if (!TRIP_ID_PATTERN.test(driverId)) {
    throw new TelemetryAuthenticationError('Authenticated driver identity is required.');
  }

  const pointRows = decodeTelemetryPayload(body);
  const payloadHash = createHash('sha256').update(body.payload_b45).digest('hex');
  return knex.transaction(async (trx) => {
    const assignedTrip = await trx('trips')
      .where({ order_id: body.trip_id, driver_id: driverId })
      .first('order_id');
    if (!assignedTrip) {
      throw new TelemetryAuthenticationError('Authenticated driver is not assigned to this trip.');
    }

    const [insertedBatch] = await trx('telemetry_ingestion_batches')
      .insert({
        idempotency_key: body.idempotency_key,
        trip_id: body.trip_id,
        driver_id: driverId,
        payload_sha256: payloadHash,
        accepted_points: pointRows.length,
      })
      .onConflict('idempotency_key')
      .ignore()
      .returning('idempotency_key');

    if (!insertedBatch) {
      const existingBatch = await trx('telemetry_ingestion_batches')
        .where({ idempotency_key: body.idempotency_key })
        .first<{ trip_id: string; driver_id: string; payload_sha256: string; accepted_points: number }>();
      if (
        !existingBatch ||
        existingBatch.trip_id !== body.trip_id ||
        existingBatch.driver_id !== driverId ||
        existingBatch.payload_sha256 !== payloadHash ||
        existingBatch.accepted_points !== pointRows.length
      ) {
        throw new TelemetryConflictError('Telemetry idempotency key conflicts with another payload.');
      }
      return existingBatch.accepted_points;
    }

    await trx('trip_telemetry_points').insert(pointRows);
    return pointRows.length;
  });
}

router.post(
  '/batch',
  async (
    req: Request<unknown, { status: string; message: string; acceptedPoints?: number }, TelemetryBatchBody>,
    res: Response,
  ): Promise<void> => {
    try {
      if (!isTelemetryBatchBody(req.body)) {
        throw new TelemetryValidationError('Invalid telemetry batch envelope.');
      }

      const body = req.body;
      const driverId = req.header('x-kona-driver-id')?.trim() ?? '';
      const signature = req.header('x-kona-signature')?.trim() ?? '';
      if (!TRIP_ID_PATTERN.test(driverId) || !signature) {
        throw new TelemetryAuthenticationError('Driver authentication headers are required.');
      }

      const secret = await DriverSecretRepository.getSecretByDriverId(driverId);
      if (
        !secret ||
        !(await CryptoSignatureEngine.verifyStrongSignature(
          telemetrySignaturePayload(body),
          signature,
          secret,
        ))
      ) {
        throw new TelemetryAuthenticationError('Telemetry driver authentication failed.');
      }

      const acceptedPoints = await storeTelemetryBatch(body, driverId);
      res.status(200).json({
        status: 'ok',
        message: 'Telemetry batch stored.',
        acceptedPoints,
      });
    } catch (error) {
      if (error instanceof TelemetryPayloadTooLargeError) {
        res.status(413).json({ status: 'error', message: error.message });
        return;
      }
      if (error instanceof TelemetryValidationError) {
        res.status(400).json({ status: 'error', message: error.message });
        return;
      }
      if (error instanceof TelemetryAuthenticationError) {
        res.status(401).json({ status: 'error', message: error.message });
        return;
      }
      if (error instanceof TelemetryConflictError) {
        res.status(409).json({ status: 'error', message: error.message });
        return;
      }
      console.error('[telemetry] Failed to store authenticated telemetry batch:', error);
      res.status(500).json({
        status: 'error',
        message: 'Telemetry storage is temporarily unavailable.',
      });
    }
  },
);

export default router;
