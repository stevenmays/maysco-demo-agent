/**
 * Drives the storyboard against a deployed stage. Run through `npm run demo -- <command>`,
 * which wraps `sst shell` so linked secrets are available without printing them.
 *
 *   setup            Create Stripe webhooks, seed the sanctions mirror, create sellers
 *   pay <seller>     A buyer pays; starts a payout saga (add --chaos=<flag>)
 *   bank <seller>    The seller switches to a new bank account
 *   list-add <name>  Publish a sanctions list with one extra fictional entity
 *   reset            Delete sagas and history; keep sellers and the sanctions list
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { connect } from "@demo/core/db/client";
import { Resource } from "sst";
import Stripe from "stripe";

// Fictional sellers. The near misses match fictional DEMO entries, so the video never
// shows a name that could belong to a real business next to a sanctions hit.
const SELLERS = {
  clean: "Brindlecove Ceramics LLC",
  near: "Quillmark Traders LLC",
  race: "Vesserot Marine LLC",
  strong: "Orlenka Freight LLC",
  harbor: "Tidewick Lantern Imports",
} as const;
type SellerKey = keyof typeof SELLERS;

const DEMO_ENTRIES: ReadonlyArray<readonly [number, string]> = [
  [990_001, "QUILLMARK TRADING HOUSE"],
  [990_002, "VESSEROT MARINE SUPPLY"],
  [990_003, "ORLENKA FREIGHT"],
];

const STATE_FILE = ".demo-state.json";
const TREASURY = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const CRLF = "\r\n";
const stripe = new Stripe(Resource.StripeSecretKey.value);
const s3 = new S3Client({});
const stage = process.env.SST_STAGE ?? "demo";

type State = { sellers: Partial<Record<SellerKey, string>> };
const load = (): State =>
  existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { sellers: {} };
const save = (s: State) => writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);

const decode = (bytes: Uint8Array) => new TextDecoder("windows-1252").decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

function setSecret(name: string, value: string) {
  // Passed on stdin so the value never appears in a process list or shell history.
  execFileSync("npx", ["sst", "secret", "set", name, "--stage", stage], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

/** Appends fictional entity rows in OFAC's SDN.CSV format, dropping the end-of-file byte. */
function appendEntries(sdn: string, entries: ReadonlyArray<readonly [number, string]>): string {
  const rows = entries.map(
    ([id, name]) =>
      `${id},"${name}",-0- ,"DEMO",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Fictional entry for the demo."`,
  );
  const body = sdn.replaceAll(String.fromCharCode(0x1a), "").trimEnd();
  return [body, ...rows, ""].join(CRLF);
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

async function download(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

async function setup() {
  const api = Resource.Api.url;
  // Rerunnable: replace this stage's own endpoints instead of adding duplicates.
  for await (const hook of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (hook.url.startsWith(api)) await stripe.webhookEndpoints.del(hook.id);
  }
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

  await putList("ALT.CSV", await download(`${TREASURY}/ALT.CSV`));
  const sdn = decode(await download(`${TREASURY}/SDN.CSV`));
  await putList("SDN.CSV", encode(appendEntries(sdn, DEMO_ENTRIES)));
  console.log(
    `Sanctions mirror seeded from Treasury, plus ${DEMO_ENTRIES.length} fictional entries.`,
  );

  const state = load();
  for (const [key, name] of Object.entries(SELLERS) as [SellerKey, string][]) {
    if (state.sellers[key]) continue;
    const account = await stripe.accounts.create({
      country: "US",
      business_type: "company",
      company: { name },
      business_profile: { name, mcc: "5999", product_description: "Demo marketplace seller" },
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

function seller(key: string): string {
  const id = load().sellers[key as SellerKey];
  if (!id) {
    throw new Error(`Unknown seller "${key}". Choose one of: ${Object.keys(SELLERS).join(", ")}`);
  }
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
  const label = SELLERS[key as SellerKey];
  console.log(`Payment ${intent.id} for ${label}${chaos ? ` (chaos: ${chaos})` : ""}`);
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
    new GetObjectCommand({
      Bucket: Resource.SanctionsMirror.name,
      Key: "sanctions/SDN.CSV",
    }),
  );
  const sdn = decode(await current.Body!.transformToByteArray());
  const entNum = 991_000 + Math.floor(Math.random() * 8_999);
  const entity = name.toUpperCase();
  await putList("SDN.CSV", encode(appendEntries(sdn, [[entNum, entity]])));
  console.log(
    `Published fictional entry ${entNum} "${entity}". The poller reads it within a minute.`,
  );
}

async function reset() {
  const db = connect(Resource.DatabaseUrl.value);
  const tables = [
    "approvals",
    "ledger_entries",
    "llm_calls",
    "saga_history",
    "outbox",
    "inbox",
  ] as const;
  for (const table of tables) await db.deleteFrom(table).execute();
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
  const names = Object.keys(commands).join("|");
  console.error(`Usage: npm run demo -- <${names}> [arg] [--chaos=skip_dispatch|llm_max_tokens]`);
  process.exit(1);
}
await run();
