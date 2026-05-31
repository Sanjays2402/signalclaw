// Seat accounting for the workspace. A "seat" = one active (non-revoked)
// API key. The cap is configured via ``SIGNALCLAW_SEAT_LIMIT`` (positive
// integer). Unset or zero means unlimited.
import { listKeys } from "./keyStore.ts";

export function seatLimit(): number {
  const raw = process.env.SIGNALCLAW_SEAT_LIMIT;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export async function activeSeatCount(): Promise<number> {
  const keys = await listKeys();
  return keys.filter((k) => !k.revoked).length;
}

export type SeatUsage = {
  used: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
};

export async function getSeatUsage(): Promise<SeatUsage> {
  const used = await activeSeatCount();
  const limit = seatLimit();
  if (limit === 0) {
    return { used, limit: 0, remaining: Number.POSITIVE_INFINITY, unlimited: true };
  }
  return { used, limit, remaining: Math.max(0, limit - used), unlimited: false };
}

export async function ensureSeatAvailable(): Promise<void> {
  const u = await getSeatUsage();
  if (u.unlimited) return;
  if (u.used >= u.limit) {
    const err: any = new Error(
      `seat limit reached: ${u.used}/${u.limit} keys in use; revoke one before minting another`,
    );
    err.status = 409;
    err.code = "seat_limit";
    throw err;
  }
}
