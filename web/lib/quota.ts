// Server-side helpers tying the quota math to the persisted run store.
import { listRuns } from "./runStore";
import { FREE_TIER_LIMIT, summarizeUsage, type UsageSummary } from "./quotaCore";

export { FREE_TIER_LIMIT, summarizeUsage };
export type { UsageSummary };

export async function getUsageSummary(now: Date = new Date()): Promise<UsageSummary> {
  const runs = await listRuns();
  return summarizeUsage(runs, now, FREE_TIER_LIMIT);
}
