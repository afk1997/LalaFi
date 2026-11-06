/** JSON helpers that round-trip bigint (tagged as {"$big": "123"}). */

export function stringifyBig(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
}

export function parseBig<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$big === 'string') {
      return BigInt(v.$big);
    }
    return v;
  }) as T;
}

/** For HTTP responses: bigint → decimal string. */
export function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
