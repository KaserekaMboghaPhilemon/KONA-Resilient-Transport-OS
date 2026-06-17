import { TripRepository } from '../TripRepository';
import { knex } from '../../database/knex';

/**
 * Sprint 8.5 – TripRepository Crash Recovery Tests
 *
 * Tests the getActiveTripIds() method which is used during app initialization
 * to detect uncompleted trips after device crash/reboot scenarios.
 */

jest.mock('../../database/knex');

const mockKnex = knex as jest.Mocked<any>;

describe('TripRepository – Crash Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getActiveTripIds()', () => {
    it('should return array of trip IDs with status=ACTIVE', async () => {
      const mockRows = [
        { order_id: 'trip-001' },
        { order_id: 'trip-002' },
        { order_id: 'trip-003' },
      ];

      // Mock the knex query chain
      const mockSelect = jest.fn().mockResolvedValue(mockRows);
      const mockWhere = jest.fn().mockReturnValue({ select: mockSelect });
      mockKnex.mockReturnValue({ where: mockWhere });

      const result = await TripRepository.getActiveTripIds();

      expect(result).toEqual(['trip-001', 'trip-002', 'trip-003']);
      expect(mockWhere).toHaveBeenCalledWith({ status: 'ACTIVE' });
      expect(mockSelect).toHaveBeenCalledWith('order_id');
    });

    it('should return empty array when no active trips exist', async () => {
      const mockSelect = jest.fn().mockResolvedValue([]);
      const mockWhere = jest.fn().mockReturnValue({ select: mockSelect });
      mockKnex.mockReturnValue({ where: mockWhere });

      const result = await TripRepository.getActiveTripIds();

      expect(result).toEqual([]);
    });

    it('should handle database errors gracefully and return empty array', async () => {
      const mockSelect = jest.fn().mockRejectedValue(new Error('Database connection failed'));
      const mockWhere = jest.fn().mockReturnValue({ select: mockSelect });
      mockKnex.mockReturnValue({ where: mockWhere });

      const result = await TripRepository.getActiveTripIds();

      // Should return empty array instead of throwing
      expect(result).toEqual([]);
    });

    it('should log errors to console when query fails', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const error = new Error('Query failed');

      const mockSelect = jest.fn().mockRejectedValue(error);
      const mockWhere = jest.fn().mockReturnValue({ select: mockSelect });
      mockKnex.mockReturnValue({ where: mockWhere });

      await TripRepository.getActiveTripIds();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[TripRepository] Failed to fetch active trips:',
        error,
      );

      consoleSpy.mockRestore();
    });
  });
});
