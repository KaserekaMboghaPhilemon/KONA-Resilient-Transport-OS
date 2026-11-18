const mockFirst = jest.fn();
const mockWhere = jest.fn();
const mockJoin = jest.fn();

jest.mock('../../database/knex', () => ({
  knex: jest.fn(() => ({
    where: mockWhere,
    join: mockJoin,
  })),
}));

import { DriverSecretRepository } from '../DriverSecretRepository';

describe('DriverSecretRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWhere.mockReturnValue({ first: mockFirst });
    mockJoin.mockReturnValue({ where: mockWhere });
  });

  it('returns a registered driver secret and normalizes the identifier', async () => {
    mockFirst.mockResolvedValue({ secret_key: 'secret-value' });

    await expect(DriverSecretRepository.getSecretByDriverId(' driver-1 ')).resolves.toBe(
      'secret-value',
    );
    expect(mockWhere).toHaveBeenCalledWith({ driver_id: 'driver-1' });
  });

  it('returns null for missing or blank secrets', async () => {
    mockFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ secret_key: '  ' });

    await expect(DriverSecretRepository.getSecretByDriverId('driver-1')).resolves.toBeNull();
    await expect(DriverSecretRepository.getSecretByDriverId('driver-1')).resolves.toBeNull();
    await expect(DriverSecretRepository.getSecretByDriverId('   ')).resolves.toBeNull();
  });

  it('propagates database failures so callers can distinguish outages from unknown drivers', async () => {
    mockFirst.mockRejectedValue(new Error('database unavailable'));

    await expect(DriverSecretRepository.getSecretByDriverId('driver-1')).rejects.toThrow(
      'database unavailable',
    );
  });

  it('looks up phone authentication and propagates database failures', async () => {
    mockFirst.mockResolvedValueOnce({
      driver_id: 'driver-1',
      secret_key: 'secret-value',
    });
    await expect(
      DriverSecretRepository.getAuthenticationByPhone('+15550000000'),
    ).resolves.toEqual({ driver_id: 'driver-1', secret_key: 'secret-value' });

    mockFirst.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      DriverSecretRepository.getAuthenticationByPhone('+15550000000'),
    ).rejects.toThrow('database unavailable');
  });
});
