/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "maysco-demo-agent",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // Set with `npx sst secret set <Name> --stage <stage>`. SST stores them in SSM.
    const secrets = {
      DatabaseUrl: new sst.Secret("DatabaseUrl"),
      AnthropicApiKey: new sst.Secret("AnthropicApiKey"),
      StripeSecretKey: new sst.Secret("StripeSecretKey"),
      StripeWebhookSecret: new sst.Secret("StripeWebhookSecret"),
      StripeConnectWebhookSecret: new sst.Secret("StripeConnectWebhookSecret"),
      SlackBotToken: new sst.Secret("SlackBotToken"),
      SlackSigningSecret: new sst.Secret("SlackSigningSecret"),
      SlackChannelId: new sst.Secret("SlackChannelId"),
    };

    // The queue consumer long-polls and the crons wake the database every minute.
    // Deploy with DEMO_PAUSED=true to keep the endpoints but stop that idle cost.
    const paused = process.env.DEMO_PAUSED === "true";
    const isDemo = $app.stage !== "production";

    // The demo serves its own copy of the sanctions list so a scene can add an entry.
    const mirror = new sst.aws.Bucket("SanctionsMirror", { access: "public" });
    const sanctionsBaseUrl = isDemo
      ? $interpolate`https://${mirror.domain}/sanctions`
      : "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";

    const environment = {
      REMIND_AFTER_MINUTES: isDemo ? "2" : "240",
      REVIEW_TTL_MINUTES: isDemo ? "5" : "1440",
    };

    const dlq = new sst.aws.Queue("StepsDlq");
    const steps = new sst.aws.Queue("Steps", {
      visibilityTimeout: "2 minutes",
      dlq: { queue: dlq.arn, retry: 5 },
    });

    const all = Object.values(secrets);
    const fn = { runtime: "nodejs22.x" as const, link: [...all, steps], environment };

    if (!paused) {
      steps.subscribe(
        { ...fn, handler: "packages/functions/src/worker.handler", timeout: "90 seconds" },
        { batch: { size: 1, partialResponses: true } },
      );
      new sst.aws.Cron("Sweeper", {
        schedule: "rate(1 minute)",
        function: {
          ...fn,
          handler: "packages/functions/src/cron-sweeper.handler",
          timeout: "60 seconds",
        },
      });
      new sst.aws.Cron("SanctionsPoller", {
        schedule: isDemo ? "rate(1 minute)" : "rate(1 hour)",
        function: {
          ...fn,
          handler: "packages/functions/src/cron-poller.handler",
          timeout: "120 seconds",
          memory: "1024 MB",
          environment: { ...environment, SANCTIONS_BASE_URL: sanctionsBaseUrl },
        },
      });
    }

    const api = new sst.aws.ApiGatewayV2("Api");
    api.route("POST /stripe/webhook", {
      ...fn,
      handler: "packages/functions/src/api-stripe.platform",
    });
    api.route("POST /stripe/connect", {
      ...fn,
      handler: "packages/functions/src/api-stripe.connect",
    });
    api.route("POST /slack/interactions", {
      ...fn,
      handler: "packages/functions/src/api-slack.handler",
      memory: "512 MB",
    });

    return { api: api.url, sanctionsMirror: mirror.name, sanctionsBaseUrl };
  },
});
