import { Request, Response, Router } from 'express';
import base45 from 'base45';
import { knex } from '../database/knex';

export interface TelemetryBatchBody {
  trip_id: string;
  payload_b45: string;
  point_count: number;
}

interface TelemetryPointRow {
  trip_id: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  timestamp: number;
}

const router = Router();

export async function storeTelemetryBatch(
  body: TelemetryBatchBody,
  authenticatedDriverId?: string,
): Promise<number> {
  if (
    !body ||
    typeof body.trip_id !== 'string' ||
    !body.trip_id.trim() ||
    typeof body.payload_b45 !== 'string' ||
    !Number.isInteger(body.point_count) ||
    body.point_count < 1
  ) {
    throw new TypeError('Invalid telemetry batch envelope.');
  }

  const decoded = base45.decode(body.payload_b45).toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0 || decoded.slice(0, separator) !== body.trip_id) {
    throw new TypeError('Telemetry payload trip_id mismatch.');
  }

  const pointRows = decoded
    .slice(separator + 1)
    .split(';')
    .map((point): TelemetryPointRow | null => {
      const [latitudeText, longitudeText, speedText, timestampText, ...extra] = point.split(',');
      if (extra.length > 0) {
        return null;
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
        (speed !== null && (!Number.isFinite(speed) || speed < 0)) ||
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0
      ) {
        return null;
      }
      return {
        trip_id: body.trip_id,
        latitude,
        longitude,
        speed,
        timestamp,
      };
    });

  if (
    pointRows.length !== body.point_count ||
    pointRows.length === 0 ||
    pointRows.some((point) => point === null)
  ) {
    throw new TypeError('Invalid telemetry point data or count.');
  }

  if (authenticatedDriverId) {
    const assignedTrip = await knex('trips')
      .where({ order_id: body.trip_id, driver_id: authenticatedDriverId })
      .first('order_id');
    if (!assignedTrip) {
      throw new Error('Authenticated driver is not assigned to this trip.');
    }
  }

  await knex('trip_telemetry_points').insert(pointRows);
  return pointRows.length;
}

router.post(
  '/batch',
  async (
    req: Request<unknown, { status: string; message: string; acceptedPoints?: number }, TelemetryBatchBody>,
    res: Response,
  ): Promise<void> => {
    const body = req.body;
    if (
      !body ||
      typeof body.trip_id !== 'string' ||
      !body.trip_id.trim() ||
      typeof body.payload_b45 !== 'string' ||
      !Number.isInteger(body.point_count) ||
      body.point_count < 1
    ) {
      res.status(400).json({ status: 'error', message: 'Invalid telemetry batch envelope.' });
      return;
    }

    try {
      const acceptedPoints = await storeTelemetryBatch(body);
      res.status(200).json({
        status: 'ok',
        message: 'Telemetry batch stored.',
        acceptedPoints,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Telemetry batch rejected.';
      res.status(400).json({ status: 'error', message });
    }
  },
);

export default router;
