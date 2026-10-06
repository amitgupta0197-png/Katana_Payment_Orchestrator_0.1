// The cheap first look on Telegram (EVERY_QUESTION groups): one tiny Haiku call with a short
// prompt, no knowledge and no lookups, that says ANSWER, SILENT or ESCALATE. Only ANSWER goes on
// to the full assistant, so messages that need no reply cost a fraction of a cent.

import Anthropic from "@anthropic-ai/sdk";
import { GATE_SYSTEM, gateInput, parseGate, type GateVerdict } from "@/lib/support-bot/telegram-rules";
import { MODELS, costEstimate } from "@/lib/support-bot/router";

export interface GateResult { verdict: GateVerdict; costUsd: number; model: string }

export async function gateMessage(question: string, context: string[] = []): Promise<GateResult> {
  const client = new Anthropic();
  const m = MODELS.LIGHT;
  const res = await client.messages.create({
    model: m.model,
    max_tokens: 5,
    system: GATE_SYSTEM,
    messages: [{ role: "user", content: gateInput(question, context) }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ");
  const cost = costEstimate({ input: res.usage.input_tokens ?? 0, output: res.usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 }, m.price);
  return { verdict: parseGate(text), costUsd: cost, model: res.model };
}
