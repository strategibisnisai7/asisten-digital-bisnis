import { handleWebhook } from "@/lib/telegram/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleWebhook(request);
}
