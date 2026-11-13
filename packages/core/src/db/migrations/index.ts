import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001 from "./0001_initial.js";
import * as m0002 from "./0002_gross_amount.js";

// Static imports so the same migrations run from a Lambda bundle, a script, and tests.
export const migrations: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "0001_initial": m0001, "0002_gross_amount": m0002 };
  },
};
