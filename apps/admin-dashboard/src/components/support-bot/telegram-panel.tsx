"use client";

// The support bot's Telegram groups, on /support-bot (lib/support-bot/telegram): which groups it
// is in and what each is linked to, a one-time link code for a new group, pause / resume / unlink,
// Katana staff's Telegram users (never answered), and the latest answers with their questions.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Group {
  chat_id: string; title: string | null; scope_key: string | null; status: "ACTIVE" | "PAUSED";
  linked_at: string | null; today: number; last_answer_at: string | null;
}
interface Answer {
  id: string; chat_id: string; title: string | null; outcome: string; reason: string | null;
  question: string | null; reply: string | null; model: string | null; created_at: string;
}
interface Data {
  enabled: boolean; paused_all: boolean; daily_limit: number; staff_chat_set: boolean;
  groups: Group[]; staff: { user_id: string; name: string | null }[]; env_staff_ids: string[]; answers: Answer[];
}

const muted = "text-[color:var(--color-text-muted)]";
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const OUTCOME: Record<string, "success" | "warning" | "danger" | "default" | "info"> = {
  ANSWERED: "success", ESCALATED: "warning", SILENT: "default", LIMIT: "info", ERROR: "danger",
};

type Action = { action: string } & Record<string, unknown>;
async function post(body: Action) {
  const r = await fetch("/api/support-bot/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

export function TelegramPanel({ scope, scopeName }: { scope: string | null; scopeName: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["support-bot", "telegram"],
    queryFn: async () => {
      const r = await fetch("/api/support-bot/telegram", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as Data;
    },
    refetchInterval: 30_000,
  });
  const [code, setCode] = useState<{ code: string; expires_at: string; for: string } | null>(null);
  const [staffId, setStaffId] = useState("");
  const [staffName, setStaffName] = useState("");
  const act = useMutation({
    mutationFn: post,
    onSuccess: (d, body: Action) => {
      if (body.action === "link_code") setCode({ ...d, for: scopeName ?? scope ?? "" });
      else toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["support-bot", "telegram"] });
    },
    onError: (e: Error) => toast.error("Not done", { description: e.message }),
  });
  const d = q.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Telegram groups <InfoTip label="Telegram groups">The assistant answers merchants in these groups. Each group sees only its linked merchant. Use Pause to stop it in a group.</InfoTip>
            {d && (d.enabled ? <Badge variant="success">On</Badge> : <Badge variant="warning">Off on this server</Badge>)}
            {d?.paused_all && <Badge variant="danger">All paused</Badge>}
          </CardTitle>
          <CardDescription>
            The assistant answers merchants&apos; questions in their Telegram groups by itself, about the account each group is linked to.
            Money owed, refunds, disputes, account changes and complaints go to the team. Up to {d?.daily_limit ?? 150} answers per group a day.
            {d && !d.staff_chat_set && " Escalations go to the ops alerts until TELEGRAM_SUPPORT_STAFF_CHAT is set."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!scope || act.isPending} onClick={() => act.mutate({ action: "link_code", scope })}>
              {scope ? `Make a link code for ${scopeName ?? scope}` : "Choose a banker or merchant above to make a link code"}
            </Button>
            {d && (
              <Button size="sm" variant={d.paused_all ? "default" : "secondary"} disabled={act.isPending}
                onClick={() => act.mutate({ action: d.paused_all ? "resume_all" : "pause_all" })}>
                {d.paused_all ? "Resume all groups" : "Pause all groups"}
              </Button>
            )}
          </div>
          {code && (
            <div className="rounded-md border px-3 py-2 text-sm">
              In the Telegram group for <b>{code.for}</b>, post: <code className="font-mono">/link {code.code}</code>
              <span className={`ml-2 text-xs ${muted}`}>One use, until {when(code.expires_at)}.</span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={`text-left text-xs ${muted}`}>
                <tr><th className="py-1 pr-3">Group</th><th className="pr-3">Linked to</th><th className="pr-3">Status</th><th className="pr-3">Today</th><th className="pr-3">Last answer</th><th /></tr>
              </thead>
              <tbody>
                {(d?.groups ?? []).map((g) => (
                  <tr key={g.chat_id} className="border-t">
                    <td className="py-2 pr-3">{g.title ?? g.chat_id}</td>
                    <td className="pr-3 font-mono text-xs">{g.scope_key ?? <span className={muted}>not linked</span>}</td>
                    <td className="pr-3">{g.status === "ACTIVE" ? <Badge variant="success">Active</Badge> : <Badge variant="warning">Paused</Badge>}</td>
                    <td className="pr-3">{g.today}</td>
                    <td className={`pr-3 ${muted}`}>{when(g.last_answer_at)}</td>
                    <td className="flex justify-end gap-1 py-1">
                      <Button size="sm" variant="secondary" disabled={act.isPending}
                        onClick={() => act.mutate({ action: g.status === "ACTIVE" ? "pause" : "resume", chat_id: g.chat_id })}>
                        {g.status === "ACTIVE" ? "Pause" : "Resume"}
                      </Button>
                      {g.scope_key && (
                        <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ action: "unlink", chat_id: g.chat_id })}>Unlink</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {d && d.groups.length === 0 && <tr><td colSpan={6} className={`py-4 text-center ${muted}`}>The bot isn&apos;t in any group yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-1.5 text-base">Katana staff on Telegram <InfoTip label="the staff list">The assistant never answers these people. Add every team member before adding the bot to a merchant group.</InfoTip></CardTitle>
          <CardDescription>The assistant never answers these people. Anyone can get their id by messaging the bot privately.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap gap-2">
            {(d?.staff ?? []).map((s) => (
              <span key={s.user_id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
                {s.name ?? "Staff"} <span className={`font-mono text-xs ${muted}`}>{s.user_id}</span>
                <button type="button" className={`ml-1 text-xs ${muted} hover:underline`} onClick={() => act.mutate({ action: "remove_staff", user_id: s.user_id })}>remove</button>
              </span>
            ))}
            {(d?.env_staff_ids ?? []).map((id) => <span key={id} className={`rounded-md border px-2 py-1 font-mono text-xs ${muted}`}>{id} (server setting)</span>)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 w-40" placeholder="Telegram user id" value={staffId} onChange={(e) => setStaffId(e.target.value.replace(/\D/g, ""))} />
            <Input className="h-8 w-48" placeholder="Name (optional)" value={staffName} onChange={(e) => setStaffName(e.target.value)} />
            <Button size="sm" disabled={!staffId || act.isPending}
              onClick={() => { act.mutate({ action: "add_staff", user_id: staffId, name: staffName || undefined }); setStaffId(""); setStaffName(""); }}>Add</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-1.5 text-base">Latest answers <InfoTip label="latest answers">What the assistant told merchants, newest first. Check them now and then.</InfoTip></CardTitle>
          <CardDescription>Every question it took and what it did. The full conversations are in the list on the Test tab.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {(d?.answers ?? []).map((a) => (
            <div key={a.id} className="rounded-md border px-3 py-2">
              <div className={`flex flex-wrap items-center gap-2 text-xs ${muted}`}>
                <Badge variant={OUTCOME[a.outcome] ?? "default"}>{a.outcome.toLowerCase()}</Badge>
                {a.reason && <span>{a.reason.toLowerCase()}</span>}
                <span>{a.title ?? a.chat_id}</span><span>{when(a.created_at)}</span>{a.model && <span>{a.model}</span>}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{a.question || "[screenshot]"}</p>
              {a.reply && <p className={`mt-1 whitespace-pre-wrap border-l-2 pl-2 ${muted}`}>{a.reply}</p>}
            </div>
          ))}
          {d && d.answers.length === 0 && <p className={muted}>Nothing yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
