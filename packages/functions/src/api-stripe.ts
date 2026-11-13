import { sellerChanged, startSaga } from "@demo/core/saga/intake";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import type Stripe from "stripe";
import { db, queue, stripe } from "./lib/deps.js";

function verify(event: APIGatewayProxyEventV2, secret: string): Stripe.Event | null {
  const signature = event.headers["stripe-signature"];
  const raw = event.body ?? "";
  const body = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  if (!signature || !body) return null;
  try {
    return stripe().webhooks.constructEvent(body, signature, secret);
  } catch {
    return null;
  }
}

const ok = (body: string): APIGatewayProxyResultV2 => ({ statusCode: 200, body });

/** Platform events: a buyer's payment starts a payout saga for the seller in its metadata. */
export async function platform(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const stripeEvent = verify(event, Resource.StripeWebhookSecret.value);
  if (!stripeEvent) return { statusCode: 400, body: "invalid signature" };
  if (stripeEvent.type !== "payment_intent.succeeded") return ok("ignored");

  const intent = stripeEvent.data.object;
  const seller = intent.metadata.seller_account;
  if (!seller) return ok("no seller");
  const result = await startSaga(db(), queue, {
    eventId: stripeEvent.id,
    paymentIntentId: intent.id,
    chargeId:
      typeof intent.latest_charge === "string"
        ? intent.latest_charge
        : (intent.latest_charge?.id ?? null),
    sellerAccountId: seller,
    amount: intent.amount_received,
    currency: intent.currency,
    chaos: intent.metadata.chaos ?? null,
  });
  return ok(result);
}

/** Connect events: the event names the account; the worker fetches its current state. */
export async function connect(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const stripeEvent = verify(event, Resource.StripeConnectWebhookSecret.value);
  if (!stripeEvent) return { statusCode: 400, body: "invalid signature" };
  if (!stripeEvent.type.startsWith("account.external_account.") || !stripeEvent.account) {
    return ok("ignored");
  }
  return ok(await sellerChanged(db(), queue, stripeEvent.id, stripeEvent.account));
}
