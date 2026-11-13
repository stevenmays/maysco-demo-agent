import type { AssessInput, AssessOutcome, Assessor } from "./agent/assess.js";
import type { Db } from "./db/client.js";
import { createTestDb } from "./db/test-db.js";
import type { Deps } from "./deps.js";
import type { Queue, QueueMessage } from "./messages.js";
import type { SanctionedEntity } from "./screening/match.js";
import type { Chat, Message } from "./slack/chat.js";
import type { Payments, SellerSnapshot } from "./stripe/payments.js";
import { handleMessage } from "./worker.js";

export class FakeQueue implements Queue {
  messages: QueueMessage[] = [];
  async send(message: QueueMessage) {
    this.messages.push(message);
  }
}

export class FakePayments implements Payments {
  sellers = new Map<string, SellerSnapshot>();
  transfers = new Map<string, { id: string; idempotencyKey: string }>();
  reversed: string[] = [];
  creates = 0;

  addSeller(accountId: string, legalName: string, bank = "fp_1:6789", country = "US") {
    this.sellers.set(accountId, { accountId, legalName, country, bankFingerprint: bank });
  }
  async getSeller(accountId: string) {
    const s = this.sellers.get(accountId);
    if (!s) throw new Error(`unknown seller ${accountId}`);
    return { ...s };
  }
  async findTransfer(sagaId: string, _destination: string) {
    return this.transfers.get(sagaId)?.id ?? null;
  }
  async createTransfer(input: Parameters<Payments["createTransfer"]>[0]) {
    this.creates++;
    const id = `tr_${this.creates}`;
    this.transfers.set(input.sagaId, { id, idempotencyKey: input.idempotencyKey });
    return id;
  }
  async reverseTransfer(transferId: string) {
    this.reversed.push(transferId);
  }
}

export class FakeAssessor implements Assessor {
  calls: AssessInput[] = [];
  constructor(public next: (input: AssessInput) => AssessOutcome = okNoMatch) {}
  async assess(input: AssessInput) {
    this.calls.push(input);
    return this.next(input);
  }
}

const call = {
  model: "fake",
  inputTokens: 10,
  outputTokens: 10,
  stopReason: "end_turn",
  latencyMs: 1,
};
export const okNoMatch = (): AssessOutcome => ({
  kind: "ok",
  call: { ...call, outcome: "ok" },
  assessment: {
    verdict: "no_match",
    matched_ent_num: null,
    reasons: ["Different industry"],
    summary: "Unrelated.",
  },
});
export const okPossible = (input: AssessInput): AssessOutcome => ({
  kind: "ok",
  call: { ...call, outcome: "ok" },
  assessment: {
    verdict: "possible_match",
    matched_ent_num: input.candidates[0]!.entity.ent_num,
    reasons: ["Distinctive name token matches"],
    summary: "The seller shares a distinctive name with a sanctioned entity.",
  },
});

export class FakeChat implements Chat {
  posts: Array<{ channel: string; message: Message }> = [];
  updates: Array<{ ts: string; message: Message }> = [];
  replies: string[] = [];
  ephemerals: Array<{ user: string; text: string }> = [];
  async post(channel: string, message: Message) {
    this.posts.push({ channel, message });
    return `ts_${this.posts.length}`;
  }
  async update(_channel: string, ts: string, message: Message) {
    this.updates.push({ ts, message });
  }
  async reply(_channel: string, _ts: string, text: string) {
    this.replies.push(text);
  }
  async ephemeral(_channel: string, user: string, text: string) {
    this.ephemerals.push({ user, text });
  }
}

export interface TestDeps extends Deps {
  queue: FakeQueue;
  payments: FakePayments;
  assessor: FakeAssessor;
  chat: FakeChat;
}

// Fictional entries, the same ones the demo adds to its copy of the SDN list.
export const ENTITIES: SanctionedEntity[] = [
  {
    ent_num: 990_001,
    name: "QUILLMARK TRADING HOUSE",
    program: "DEMO",
    remarks: null,
    aliases: [],
  },
  {
    ent_num: 990_002,
    name: "VESSEROT MARINE SUPPLY",
    program: "DEMO",
    remarks: null,
    aliases: ["VESSEROT SHIPPING"],
  },
  { ent_num: 990_003, name: "ORLENKA FREIGHT", program: "DEMO", remarks: null, aliases: [] },
];

export async function seedEntities(db: Db, entities = ENTITIES) {
  await db
    .insertInto("sanctions_entities")
    .values(entities.map((e) => ({ ...e, aliases: JSON.stringify(e.aliases) })))
    .execute();
  await db
    .insertInto("sanctions_list_versions")
    .values({
      content_hash: "seed",
      last_modified: null,
      entity_count: entities.length,
      added_count: 0,
    })
    .execute();
}

export async function makeDeps(): Promise<TestDeps> {
  const db = await createTestDb();
  await seedEntities(db);
  return {
    db,
    queue: new FakeQueue(),
    payments: new FakePayments(),
    assessor: new FakeAssessor(),
    chat: new FakeChat(),
    findLei: async () => null,
    config: { slackChannel: "C_REVIEW", remindAfterMinutes: 60, reviewTtlMinutes: 180 },
  };
}

/** Delivers queued messages in order until the queue is empty, like a FIFO SQS consumer. */
export async function drain(deps: TestDeps, attempt = 1) {
  for (let i = 0; i < 500 && deps.queue.messages.length; i++) {
    await handleMessage(deps, deps.queue.messages.shift()!, attempt);
  }
}

export async function ledgerTotals(db: Db) {
  const rows = await db
    .selectFrom("ledger_entries")
    .select(["txn_id", "account", "amount"])
    .execute();
  const byTxn = new Map<string, number>();
  const byAccount = new Map<string, number>();
  for (const r of rows) {
    byTxn.set(r.txn_id, (byTxn.get(r.txn_id) ?? 0) + r.amount);
    byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + r.amount);
  }
  return { byTxn, byAccount };
}
