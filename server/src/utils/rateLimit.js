const requestBuckets = new Map();

function clientAddress(socket) {
  return String(socket?.handshake?.address || "unknown");
}

export function allowByRateLimit(socket, action, cfg) {
  const ip = clientAddress(socket);
  const now = Date.now();
  const key = `${ip}:${action}`;
  const bucket = requestBuckets.get(key) || { count: 0, resetAt: now + cfg.windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + cfg.windowMs;
  }
  bucket.count += 1;
  requestBuckets.set(key, bucket);
  return bucket.count <= cfg.max;
}
