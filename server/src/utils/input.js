const textEncoder = new TextEncoder();

export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function payloadBytes(value) {
  try {
    return textEncoder.encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function clampStringInput(value, opts = {}) {
  const {
    minLen = 0,
    maxLen = 128,
    trim = true,
    uppercase = false,
    pattern = null,
  } = opts;
  if (typeof value !== "string") return null;
  let out = trim ? value.trim() : value;
  if (uppercase) out = out.toUpperCase();
  if (out.length < minLen || out.length > maxLen) return null;
  if (pattern && !pattern.test(out)) return null;
  return out;
}

export function clampIntInput(value, opts = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
