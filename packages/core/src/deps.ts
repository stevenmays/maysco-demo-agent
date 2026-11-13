import type { Assessor } from "./agent/assess.js";
import type { Db } from "./db/client.js";
import type { Queue } from "./messages.js";
import type { LeiRecord } from "./screening/gleif.js";
import type { Chat } from "./slack/chat.js";
import type { Payments } from "./stripe/payments.js";

export interface Deps {
  db: Db;
  queue: Queue;
  payments: Payments;
  assessor: Assessor;
  chat: Chat;
  findLei(name: string): Promise<LeiRecord | null>;
  config: {
    slackChannel: string;
    remindAfterMinutes: number;
    reviewTtlMinutes: number;
  };
}

export const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);
