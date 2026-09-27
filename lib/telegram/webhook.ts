import "server-only";
import { handleTelegramUpdate } from "./adapter";
import { createTelegramBot } from "./bot-service";
import { equalSecret, getWebhookSecret } from "./config";

interface WebhookDependencies {
  secret: () => string;
  handle: (update: unknown, secret: string) => Promise<void>;
}

export function createWebhookHandler(dependencies: WebhookDependencies) {
  return async (request: Request): Promise<Response> => {
    const reply = (status: number, body: object) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    let secret: string;
    try { secret = dependencies.secret(); } catch { return reply(503, { ok: false, error: "Webhook belum dikonfigurasi." }); }
    if (!equalSecret(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
      return reply(401, { ok: false, error: "Unauthorized" });
    }
    if (Number(request.headers.get("content-length")) > 131072) return reply(413, { ok: false, error: "Payload terlalu besar." });
    let update: unknown;
    try {
      const body = await request.text();
      if (Buffer.byteLength(body, "utf8") > 131072) return reply(413, { ok: false, error: "Payload terlalu besar." });
      update = JSON.parse(body);
    } catch { return reply(400, { ok: false, error: "JSON tidak valid." }); }
    if (!update || typeof update !== "object" || !("update_id" in update) || !Number.isSafeInteger(update.update_id)) {
      return reply(400, { ok: false, error: "Update tidak valid." });
    }
    try {
      await dependencies.handle(update, secret);
      return reply(200, { ok: true });
    } catch {
      // A non-2xx response lets Telegram retry; never serialize raw API errors.
      return reply(503, { ok: false, error: "Respons Telegram belum dapat dikirim." });
    }
  };
}

export const handleWebhook = createWebhookHandler({
  secret: getWebhookSecret,
  handle: (update, secret) => handleTelegramUpdate(update, { secret, bot: createTelegramBot() }),
});
