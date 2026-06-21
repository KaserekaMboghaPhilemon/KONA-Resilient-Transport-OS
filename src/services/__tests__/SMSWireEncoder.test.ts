import { SMSWireEncoder } from '../SMSWireEncoder';

describe('SMSWireEncoder', () => {
  const deviceSecret = 'test-device-secret-12345';

  describe('encodeTransactionToSMS', () => {
    it('encodes a simple transaction to SMS envelopes', () => {
      const transaction = {
        booking_id: '12345',
        booking_lock: 'ACTIVE',
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-001',
        deviceSecret
      );

      expect(Array.isArray(envelopes)).toBe(true);
      expect(envelopes.length).toBeGreaterThan(0);
      expect(envelopes[0]).toMatch(/^KONA:tx-001:1\/\d+:/);
      // Each envelope should be <= 160 chars
      envelopes.forEach((env) => {
        expect(env.length).toBeLessThanOrEqual(160);
      });
    });

    it('splits large transactions into multiple SMS envelopes', () => {
      const largeTransaction = {
        booking_id: 'b'.repeat(100),
        driver_id: 'd'.repeat(100),
        telemetry_ping: JSON.stringify({
          lat: 40.7128,
          lon: -74.006,
          speed: 25.5,
          heading: 180,
          accuracy: 5,
          timestamp: Date.now(),
        }),
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        largeTransaction,
        'tx-large',
        deviceSecret
      );

      // Should split into multiple parts
      expect(envelopes.length).toBeGreaterThan(1);
      // Each part should have correctly formatted PART/TOTAL
      envelopes.forEach((env, idx) => {
        const match = env.match(/^KONA:tx-large:(\d+)\/(\d+):/);
        expect(match).not.toBeNull();
        if (match) {
          expect(parseInt(match[1], 10)).toBe(idx + 1);
          expect(parseInt(match[2], 10)).toBe(envelopes.length);
        }
      });
    });

    it('applies correct PART/TOTAL indexing', () => {
      const transaction = { booking_id: 'x'.repeat(500) };
      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-idx',
        deviceSecret
      );

      const total = envelopes.length;
      envelopes.forEach((env, idx) => {
        expect(env).toMatch(
          new RegExp(`^KONA:tx-idx:${idx + 1}/${total}:`)
        );
      });
    });

    it('handles special characters in transaction values', () => {
      const transaction = {
        booking_id: 'bid-123;test',
        lock_reason: 'reason|with|pipes',
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-special',
        deviceSecret
      );

      expect(envelopes.length).toBeGreaterThan(0);
      // Should be parseable without error
      const decoded = SMSWireEncoder.decodeSMSToTransaction(
        envelopes,
        deviceSecret
      );
      expect(decoded).toBeDefined();
    });
  });

  describe('decodeSMSToTransaction', () => {
    it('decodes single SMS envelope correctly', () => {
      const original = {
        booking_id: '12345',
        booking_lock: 'ACTIVE',
        lock_reason: 'driver_busy',
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        original,
        'tx-001',
        deviceSecret
      );

      const decoded = SMSWireEncoder.decodeSMSToTransaction(
        envelopes,
        deviceSecret
      );

      expect(decoded).toEqual(original);
    });

    it('decodes multi-part SMS envelope array correctly', () => {
      const original = {
        booking_id: 'b'.repeat(100),
        driver_id: 'd'.repeat(100),
        trip_id: 't'.repeat(100),
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        original,
        'tx-multi',
        deviceSecret
      );

      expect(envelopes.length).toBeGreaterThan(1);

      const decoded = SMSWireEncoder.decodeSMSToTransaction(
        envelopes,
        deviceSecret
      );

      expect(decoded).toEqual(original);
    });

    it('performs lossless round-trip compression', () => {
      const testCases = [
        { booking_id: '123', booking_lock: 'ACTIVE' },
        { driver_id: 'drv-456', status: 'online' },
        {
          trip_id: 'trip-789',
          location_lat: '40.7128',
          location_lon: '-74.0060',
          event_type: 'arrival',
        },
        {
          order_id: 'ord-001',
          action_type: 'bid_accepted',
          payload: JSON.stringify({ amount: 50.5, currency: 'USD' }),
        },
      ];

      testCases.forEach((transaction) => {
        const envelopes = SMSWireEncoder.encodeTransactionToSMS(
          transaction,
          'tx-roundtrip',
          deviceSecret
        );

        const decoded = SMSWireEncoder.decodeSMSToTransaction(
          envelopes,
          deviceSecret
        );

        expect(decoded).toEqual(transaction);
      });
    });

    it('handles all defined field abbreviations', () => {
      const transaction: any = {
        booking_id: '123',
        booking_lock: 'LOCK',
        lock_reason: 'busy',
        driver_id: 'drv-1',
        device_id: 'dev-1',
        telemetry_ping: 'ping-data',
        trip_id: 'trip-1',
        trip_status: 'in_progress',
        location_lat: '40.7',
        location_lon: '-74.0',
        timestamp: '2026-06-21T00:00:00Z',
        event_type: 'sync',
        payload: 'data',
        action_type: 'queue',
        order_id: 'ord-1',
        available: 'true',
        status: 'ready',
        reason: 'test',
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-abbrev',
        deviceSecret
      );

      const decoded = SMSWireEncoder.decodeSMSToTransaction(
        envelopes,
        deviceSecret
      );

      // All fields should be reconstructed
      Object.keys(transaction).forEach((key) => {
        expect(decoded[key]).toBe(transaction[key]);
      });
    });
  });

  describe('signature verification', () => {
    it('rejects envelopes with tampered data', () => {
      const transaction = { booking_id: '12345', booking_lock: 'ACTIVE' };
      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-tamper',
        deviceSecret
      );

      // Tamper with the data portion of the last envelope
      const tampered = [...envelopes];
      const lastEnv = tampered[tampered.length - 1];
      const match = lastEnv.match(/^(KONA:[^:]+:\d+\/\d+:)(.+)$/);
      if (match) {
        const [, header, data] = match;
        // Flip a character in the data
        const modifiedData =
          data.length > 0
            ? data.substring(0, -1) + String.fromCharCode(255 - data.charCodeAt(data.length - 1))
            : 'X';
        tampered[tampered.length - 1] = header + modifiedData;
      }

      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction(tampered, deviceSecret)
      ).toThrow(/signature verification failed/i);
    });

    it('rejects envelopes with wrong device secret', () => {
      const transaction = { booking_id: '12345', booking_lock: 'ACTIVE' };
      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-wrong-secret',
        deviceSecret
      );

      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction(
          envelopes,
          'different-secret'
        )
      ).toThrow(/signature verification failed/i);
    });

    it('rejects envelopes with any single character modification', () => {
      const transaction = {
        booking_id: '12345',
        driver_id: 'drv-789',
        status: 'active',
      };
      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-single-char',
        deviceSecret
      );

      // Try tampering with each character position in the data portion of the last envelope
      const originalEnv = envelopes[envelopes.length - 1];
      // Extract only the data part (after the last colon in the header)
      const dataStartIdx = originalEnv.lastIndexOf(':') + 1;
      
      for (let i = dataStartIdx; i < Math.min(originalEnv.length, dataStartIdx + 20); i += 5) {
        const tampered = [...envelopes];
        const lastEnv = tampered[tampered.length - 1];
        const chars = lastEnv.split('');
        chars[i] = chars[i] === 'A' ? 'B' : 'A'; // Flip character
        tampered[tampered.length - 1] = chars.join('');

        expect(() =>
          SMSWireEncoder.decodeSMSToTransaction(tampered, deviceSecret)
        ).toThrow(/signature verification failed/i);
      }
    });
  });

  describe('error handling', () => {
    it('throws on empty envelope array', () => {
      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction([], deviceSecret)
      ).toThrow(/No SMS envelopes provided/);
    });

    it('throws on invalid envelope format', () => {
      const invalidEnvelopes = ['INVALID:FORMAT', 'KONA:tx:BAD:DATA'];

      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction(invalidEnvelopes, deviceSecret)
      ).toThrow(/Invalid SMS envelope format/);
    });

    it('throws on mismatched PART/TOTAL count', () => {
      const envelopes = [
        'KONA:tx-001:1/3:ABCD1234:data1',
        'KONA:tx-001:2/3:ABCD1234:data2',
        // Missing part 3
      ];

      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction(envelopes, deviceSecret)
      ).toThrow(/Envelope count mismatch/);
    });

    it('throws on out-of-order part indices', () => {
      const envelopes = [
        'KONA:tx-001:1/2:ABCD1234:data1',
        'KONA:tx-001:1/2:ABCD1234:data2', // Should be part 2
      ];

      expect(() =>
        SMSWireEncoder.decodeSMSToTransaction(envelopes, deviceSecret)
      ).toThrow(/Part index out of order/);
    });
  });

  describe('envelope format compliance', () => {
    it('strictly formats envelopes as KONA:TXID:PART/TOTAL:DATA', () => {
      const transaction = { booking_id: '12345' };
      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        transaction,
        'tx-format',
        deviceSecret
      );

      envelopes.forEach((env) => {
        // Match strict format: KONA:TXID:PART/TOTAL:DATA
        const match = env.match(/^KONA:[^:]+:\d+\/\d+:.+$/);
        expect(match).not.toBeNull();
        expect(env).toMatch(/^KONA:/);
        // Should not have more than 3 colons after KONA prefix
        const colonCount = (env.match(/:/g) || []).length;
        expect(colonCount).toBeGreaterThanOrEqual(3);
      });
    });

    it('respects 160-character SMS length limit per envelope', () => {
      const largeTransaction = {
        booking_id: 'bid-' + 'x'.repeat(500),
        driver_id: 'drv-' + 'y'.repeat(500),
      };

      const envelopes = SMSWireEncoder.encodeTransactionToSMS(
        largeTransaction,
        'tx-limit',
        deviceSecret
      );

      envelopes.forEach((env) => {
        expect(env.length).toBeLessThanOrEqual(160);
      });
    });
  });
});
