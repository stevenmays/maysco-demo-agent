import crypto from "node:crypto";

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  // Reject requests older than 5 minutes to stop replays.
  if (Math.abs(nowSeconds - Number.parseInt(timestamp, 10)) > 300) return false;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
