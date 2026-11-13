/**
 * Drives the storyboard against a deployed stage. Run through `npm run demo -- <command>`,
 * which wraps `sst shell` so linked secrets are available without printing them.
 *
 *   setup            Create Stripe webhooks, seed the sanctions mirror, create sellers
 *   pay <seller>     A buyer pays; starts a payout saga (add --chaos=<flag>)
 *   bank <seller>    The seller switches to a new bank account
 *   list-add <name>  Publish a sanctions list with one extra entity
 *   reset            Delete sagas and history; keep sellers and the sanctions list
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { connect } from "@demo/core/db/client";
import { Resource } from "sst";
import Stripe from "stripe";

const SELLERS = {
  clean: "Maple Ridge Ceramics LLC",
  near: "Cimex Logistics Ltd",
  race: "Coprova Trading SARL",
  strong: "Avia Import LLC",
  harbor: "Harbor Lantern Imports",
} as const;
type SellerKey = keyof typeof SELLERS;

const STATE_FILE = ".demo-state.json";
const TREASURY = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const stripe = new Stripe(Resource.StripeSecretKey.value);
const s3 = new S3Client({});
const stage = process.env.SST_STAGE ?? "demo";

type State = { sellers: Partial<Record<SellerKey, string>> };
const load = (): State =>
  existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { sellers: {} };
const save = (s: State) => writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);

function setSecret(name: string, value: string) {
  // Passed on stdin so the value never appears in a process list or shell history.
  execFileSync("npx", ["sst", "secret", "set", name, "--stage", stage], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

async function setup() {
  const api = Resource.Api.url;
  const platform = await stripe.webhookEndpoints.create({
    url: `${api}/stripe/webhook`,
    enabled_events: ["payment_intent.succeeded"],
  });
  const connectHook = await stripe.webhookEndpoints.create({
    url: `${api}/stripe/connect`,
    connect: true,
    enabled_events: ["account.external_account.created", "account.external_account.updated"],
  });
  setSecret("StripeWebhookSecret", platform.secret!);
  setSecret("StripeConnectWebhookSecret", connectHook.secret!);
  console.log(
    "Stripe webhooks created. Run `npm run deploy` so the functions read the new secrets.",
  );

  for (const file of ["SDN.CSV", "ALT.CSV"]) {
    const body = new Uint8Array(await (await fetch(`${TREASURY}/${file}`)).arrayBuffer());
    await putList(file, body);
  }
  console.log("Sanctions mirror seeded from Treasury.");

  const state = load();
  for (const [key, name] of Object.entries(SELLERS) as [SellerKey, string][]) {
    if (state.sellers[key]) continue;
    const account = await stripe.accounts.create({
      country: "US",
      business_type: "company",
      company: { name },
      business_profile: { name, mcc: "5999", url: "https://example.com" },
      capabilities: { transfers: { requested: true } },
      controller: {
        stripe_dashboard: { type: "none" },
        fees: { payer: "application" },
        losses: { payments: "application" },
        requirement_collection: "application",
      },
      external_account: "btok_us_verified",
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    });
    state.sellers[key] = account.id;
    console.log(`Seller ${name}: ${account.id}`);
  }
  save(state);
}

async function putList(file: string, body: Uint8Array) {
  await s3.send(
    new PutObjectCommand({
      Bucket: Resource.SanctionsMirror.name,
      Key: `sanctions/${file}`,
      Body: body,
      ContentType: "text/csv",
    }),
  );
}

function seller(key: string): string {
  const id = load().sellers[key as SellerKey];
  if (!id)
    throw new Error(`Unknown seller "${key}". Choose one of: ${Object.keys(SELLERS).join(", ")}`);
  return id;
}

async function pay(key: string, chaos?: string) {
  const intent = await stripe.paymentIntents.create({
    amount: 12_500,
    currency: "usd",
    payment_method: "pm_card_bypassPending",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    confirm: true,
    metadata: { seller_account: seller(key), ...(chaos ? { chaos } : {}) },
  });
  console.log(
    `Payment ${intent.id} for ${SELLERS[key as SellerKey]}${chaos ? ` (chaos: ${chaos})` : ""}`,
  );
}

async function changeBank(key: string) {
  const bank = await stripe.accounts.createExternalAccount(seller(key), {
    external_account: "btok_us_verified",
    default_for_currency: true,
  });
  console.log(`New default bank account ${bank.id} for ${SELLERS[key as SellerKey]}`);
}

async function listAdd(name: string) {
  const current = await s3.send(
    new GetObjectCommand({ Bucket: Resource.SanctionsMirror.name, Key: "sanctions/SDN.CSV" }),
  );
  const text = new TextDecoder("windows-1252").decode(await current.Body!.transformToByteArray());
  const entNum = 990_000 + Math.floor(Math.random() * 9_999);
  const row = `${entNum},"${name.toUpperCase()}",-0- ,"DEMO",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Fictional entry added for the demo."`;
  const body = `${text.replace(/\u001a\s*$/, "").trimEnd()}\r\n${row}\r\n`;
  await putList("SDN.CSV", new TextEncoder().encode(body));
  console.log(
    `Published a list with fictional entity ${entNum} "${name.toUpperCase()}". The poller picks it up within a minute.`,
  );
}

async function reset() {
  const db = connect(Resource.DatabaseUrl.value);
  for (const table of [
    "approvals",
    "ledger_entries",
    "llm_calls",
    "saga_history",
    "outbox",
    "inbox",
  ] as const) {
    await db.deleteFrom(table).execute();
  }
  await db.deleteFrom("sagas").execute();
  await db.destroy();
  console.log("Deleted sagas, history, outbox, inbox, approvals, ledger, and model calls.");
}

const [command, arg] = process.argv.slice(2);
const chaos = process.argv.find((a) => a.startsWith("--chaos="))?.split("=")[1];
const commands: Record<string, () => Promise<void>> = {
  setup,
  pay: () => pay(arg!, chaos),
  bank: () => changeBank(arg!),
  "list-add": () => listAdd(arg!),
  reset,
};
const run = commands[command ?? ""];
if (!run) {
  console.error(
    `Usage: npm run demo -- <${Object.keys(commands).join("|")}> [arg] [--chaos=skip_dispatch|llm_max_tokens]`,
  );
  process.exit(1);
}
await run();
