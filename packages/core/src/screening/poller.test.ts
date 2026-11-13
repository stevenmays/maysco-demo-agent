import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { FakeQueue } from "../test-utils.js";
import { pollSanctions } from "./poller.js";

const row = (id: number, name: string) =>
  `${id},"${name}",-0- ,"DEMO",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `;
const baseList = Array.from({ length: 1_000 }, (_, i) => row(i + 1, `ENTITY ${i + 1}`));

function serve(files: Record<string, string>): typeof fetch {
  return (async (url: string | URL) => {
    const name = String(url).split("/").pop()!;
    return new Response(files[name] ?? "", { status: 200 });
  }) as typeof fetch;
}

let db: Db;
let queue: FakeQueue;
beforeEach(async () => {
  db = await createTestDb();
  queue = new FakeQueue();
});
afterEach(async () => db.destroy());

describe("pollSanctions", () => {
  it("loads a baseline, ignores an unchanged list, and emits only additions", async () => {
    const first = await pollSanctions(
      { db, queue },
      "https://x",
      serve({ "SDN.CSV": baseList.join("\n"), "ALT.CSV": "" }),
    );
    expect(first).toMatchObject({ changed: true, added: [] });
    expect(queue.messages).toEqual([]);

    const same = await pollSanctions(
      { db, queue },
      "https://x",
      serve({ "SDN.CSV": baseList.join("\n"), "ALT.CSV": "" }),
    );
    expect(same.changed).toBe(false);

    const next = [...baseList, row(5_000, "HARBOR LANTERN IMPORTS LIMITED")].join("\n");
    const changed = await pollSanctions(
      { db, queue },
      "https://x",
      serve({ "SDN.CSV": next, "ALT.CSV": "" }),
    );
    expect(changed.added).toEqual([5_000]);
    expect(queue.messages).toEqual([{ kind: "list.changed", added: [5_000] }]);
  });

  it("refuses a truncated list instead of wiping the table", async () => {
    await expect(
      pollSanctions(
        { db, queue },
        "https://x",
        serve({ "SDN.CSV": row(1, "ONLY ONE"), "ALT.CSV": "" }),
      ),
    ).rejects.toThrow("Refusing");
  });
});
