import type { X402Challenge } from "./types.js";

export function encodeChallenge(challenge: X402Challenge): string {
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
}

export function decodeChallenge(encoded: string): X402Challenge {
  return JSON.parse(
    Buffer.from(encoded, "base64").toString("utf-8"),
  ) as X402Challenge;
}
