import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalJson(value: unknown): string {
  // Deterministic key ordering for this MVP. Upgrade to RFC 8785 JCS before production.
  const normalize = (v: any): any => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])]));
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

export function merkleRoot(records: unknown[]): string {
  if (records.length === 0) return sha256("PROOFNAV_EMPTY");
  let level = records.map(record => sha256(Buffer.concat([
    Buffer.from([0]), Buffer.from(canonicalJson(record), "utf8")
  ])));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256(Buffer.concat([
        Buffer.from([1]), Buffer.from(left, "hex"), Buffer.from(right, "hex")
      ])));
    }
    level = next;
  }
  return level[0];
}
