import { AIChatAgent } from "@cloudflare/ai-chat";

export class MailAgent extends AIChatAgent<CloudflareBindings> {
  async onChatMessage(): Promise<Response> {
    return new Response("Mail agent runtime ready", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
