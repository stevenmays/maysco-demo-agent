import { type KnownBlock, WebClient } from "@slack/web-api";

export interface Message {
  text: string;
  blocks: unknown[];
}

export interface Chat {
  post(channel: string, message: Message): Promise<string>;
  update(channel: string, ts: string, message: Message): Promise<void>;
  reply(channel: string, threadTs: string, text: string): Promise<void>;
  ephemeral(channel: string, user: string, text: string): Promise<void>;
}

export class SlackChat implements Chat {
  private readonly client: WebClient;
  constructor(token: string) {
    this.client = new WebClient(token);
  }

  async post(channel: string, message: Message): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel,
      text: message.text,
      blocks: message.blocks as KnownBlock[],
    });
    return res.ts!;
  }

  async update(channel: string, ts: string, message: Message): Promise<void> {
    await this.client.chat.update({
      channel,
      ts,
      text: message.text,
      blocks: message.blocks as KnownBlock[],
    });
  }

  async reply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.client.chat.postMessage({ channel, thread_ts: threadTs, text });
  }

  async ephemeral(channel: string, user: string, text: string): Promise<void> {
    await this.client.chat.postEphemeral({ channel, user, text });
  }
}
