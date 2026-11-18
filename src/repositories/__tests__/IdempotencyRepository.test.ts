import type { Knex } from 'knex';

const mockInsert = jest.fn();
const mockOnConflict = jest.fn();
const mockIgnore = jest.fn();
const mockReturning = jest.fn();

jest.mock('../../database/knex', () => ({
  knex: jest.fn(),
}));

import { IdempotencyRepository } from '../IdempotencyRepository';

describe('IdempotencyRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockReturnValue({ onConflict: mockOnConflict });
    mockOnConflict.mockReturnValue({ ignore: mockIgnore });
    mockIgnore.mockReturnValue({ returning: mockReturning });
  });

  it('registers new keys through the supplied transaction', async () => {
    const trx = jest.fn().mockReturnValue({ insert: mockInsert }) as unknown as Knex.Transaction;
    mockReturning.mockResolvedValue([{ key: 'idempotency-1' }]);

    await expect(IdempotencyRepository.checkAndRegisterKey('idempotency-1', trx)).resolves.toBe(false);

    expect(trx).toHaveBeenCalledWith('processed_idempotency_keys');
    expect(mockOnConflict).toHaveBeenCalledWith('key');
    expect(mockIgnore).toHaveBeenCalled();
    expect(mockReturning).toHaveBeenCalledWith('key');
  });

  it('reports an existing key as a duplicate without throwing', async () => {
    const trx = jest.fn().mockReturnValue({ insert: mockInsert }) as unknown as Knex.Transaction;
    mockReturning.mockResolvedValue([]);

    await expect(IdempotencyRepository.checkAndRegisterKey('duplicate-key', trx)).resolves.toBe(true);
  });

  it('propagates database failures instead of treating them as duplicates', async () => {
    const trx = jest.fn().mockReturnValue({ insert: mockInsert }) as unknown as Knex.Transaction;
    mockReturning.mockRejectedValue(new Error('database unavailable'));

    await expect(IdempotencyRepository.checkAndRegisterKey('key', trx)).rejects.toThrow(
      'database unavailable',
    );
  });
});
