/**
 * Minimal ambient type declaration for the `base45` package.
 * base45 does not ship its own .d.ts file. This declaration provides the
 * encode/decode surface used by SMSReassemblyManager.
 */
declare module 'base45' {
  /**
   * Encodes a Buffer or Uint8Array into a Base45 ASCII string.
   */
  function encode(input: Buffer | Uint8Array): string;

  /**
   * Decodes a Base45 ASCII string into a Buffer.
   */
  function decode(input: string): Buffer;

  export { encode, decode };
}
