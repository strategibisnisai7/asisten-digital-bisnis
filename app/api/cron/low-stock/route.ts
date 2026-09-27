import { runLowStockNotifications } from "@/lib/notifications/low-stock-notification";
import { createTelegramBot } from "@/lib/telegram/bot-service";
import { equalSecret } from "@/lib/telegram/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CronDependencies {
  secret: () => string;
  run: typeof runLowStockNotifications;
}

export function createLowStockCronHandler(dependencies: CronDependencies) {
  return async (request: Request): Promise<Response> => {
    let secret: string;
    try {
      secret = dependencies.secret();
    } catch {
      return Response.json({ ok: false, error: "Cron belum dikonfigurasi." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!equalSecret(authorization, `Bearer ${secret}`)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const result = await dependencies.run({
        send: createTelegramBot().sendMessage,
        onError: (error) => console.error(`[cron-low-stock] Pengiriman gagal (${error instanceof Error ? error.name : "unknown"})`),
      });
      return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error(`[cron-low-stock] Proses gagal (${error instanceof Error ? error.name : "unknown"})`);
      return Response.json({ ok: false, error: "Notifikasi belum dapat diproses." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const GET = createLowStockCronHandler({
  secret: () => {
    const value = process.env.CRON_SECRET?.trim();
    if (!value || value.length < 16) throw new Error("CRON_SECRET invalid");
    return value;
  },
  run: runLowStockNotifications,
});
