import { pollSanctions } from "@demo/core/screening/poller";
import { db, queue } from "./lib/deps.js";

export async function handler() {
  const result = await pollSanctions({ db: db(), queue }, process.env.SANCTIONS_BASE_URL!);
  console.info("sanctions poll", {
    changed: result.changed,
    added: result.added.length,
    removed: result.removed.length,
  });
  return result;
}
