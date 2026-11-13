import { sweep } from "@demo/core/saga/sweeper";
import { getDeps } from "./lib/deps.js";

export async function handler() {
  const result = await sweep(getDeps());
  if (Object.values(result).some((n) => n > 0)) console.info("sweep", result);
  return result;
}
