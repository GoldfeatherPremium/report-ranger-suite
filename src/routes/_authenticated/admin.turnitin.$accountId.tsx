import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { ArrowLeft, Plus, Trash2, Power } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin/turnitin/$accountId")({ component: Page });

type Slot = {
  id: string; account_id: string; label: string; submit_url: string | null;
  cooldown_hours: number; is_active: boolean; created_at: string;
  last_used_at?: string | null;
};

function Page() {
  const { accountId } = Route.useParams();
  const [open, setOpen] = useState(false);

  const { data: account } = useQuery({
    queryKey: ["turnitin_account", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_accounts" as never)
        .select("id,label,email")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as { id: string; label: string; email: string } | null;
    },
  });

  const { data: slots = [], refetch } = useQuery({
    queryKey: ["turnitin_slots", accountId],
    queryFn: async () => {
      const { data: s, error } = await supabase
        .from("turnitin_slots" as never)
        .select("id,account_id,label,submit_url,cooldown_hours,is_active,created_at")
        .eq("account_id", accountId)
        .order("created_at");
      if (error) throw error;
      const slots = (s ?? []) as unknown as Slot[];
      // fetch latest usage per slot
      if (slots.length) {
        const ids = slots.map((x) => x.id);
        const { data: usages } = await supabase
          .from("turnitin_slot_usage" as never)
          .select("slot_id,submitted_at")
          .in("slot_id", ids)
          .order("submitted_at", { ascending: false });
        const latest = new Map<string, string>();
        ((usages ?? []) as unknown as { slot_id: string; submitted_at: string }[])
          .forEach((u) => { if (!latest.has(u.slot_id)) latest.set(u.slot_id, u.submitted_at); });
        slots.forEach((x) => { x.last_used_at = latest.get(x.id) ?? null; });
      }
      return slots;
    },
  });

  async function toggleActive(s: Slot) {
    const { error } = await supabase.from("turnitin_slots" as never).update({ is_active: !s.is_active } as never).eq("id", s.id);
    if (error) toast.error(error.message); else refetch();
  }
  async function remove(s: Slot) {
    if (!confirm("Delete this slot?")) return;
    const { error } = await supabase.from("turnitin_slots" as never).delete().eq("id", s.id);
    if (error) toast.error(error.message); else refetch();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/turnitin"><ArrowLeft className="mr-1 h-4 w-4" /> All accounts</Link>
      </Button>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">{account?.label ?? "Account"} — Slots</h2>
          <p className="text-sm text-muted-foreground">{account?.email}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Add slot</Button></DialogTrigger>
          <AddSlotDialog accountId={accountId} onDone={() => { setOpen(false); refetch(); }} />
        </Dialog>
      </div>

      <div className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Submit URL</th>
              <th className="px-4 py-3">Cooldown</th>
              <th className="px-4 py-3">Availability</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {slots.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No slots yet.</td></tr>}
            {slots.map((s) => {
              const free = !s.last_used_at || (Date.now() - new Date(s.last_used_at).getTime()) > s.cooldown_hours * 3600_000;
              return (
                <tr key={s.id} className="border-b last:border-0 hover:bg-accent/30">
                  <td className="px-4 py-3 font-medium">{s.label}</td>
                  <td className="px-4 py-3 truncate text-xs text-muted-foreground max-w-xs">{s.submit_url || "—"}</td>
                  <td className="px-4 py-3">{s.cooldown_hours}h</td>
                  <td className="px-4 py-3">
                    {!s.is_active ? (
                      <span className="text-xs text-muted-foreground">Disabled</span>
                    ) : free ? (
                      <span className="text-xs text-success">Free now</span>
                    ) : (
                      <span className="text-xs text-warning">Used {formatDistanceToNow(new Date(s.last_used_at!))} ago</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="icon" onClick={() => toggleActive(s)} title="Toggle"><Power className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(s)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddSlotDialog({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [submitUrl, setSubmitUrl] = useState("");
  const [cooldown, setCooldown] = useState(24);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label) { toast.error("Label is required"); return; }
    setSaving(true);
    const { error } = await supabase.from("turnitin_slots" as never).insert({
      account_id: accountId, label, submit_url: submitUrl || null, cooldown_hours: cooldown,
    } as never);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Slot added"); onDone();
  }

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Add slot</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Class A / Assignment 1" /></div>
        <div>
          <Label>Assignment dashboard URL</Label>
          <Input value={submitUrl} onChange={(e) => setSubmitUrl(e.target.value)} placeholder="https://www.turnitin.com/assignment/type/paper/dashboard/<id>?lang=en_us" />
          <p className="text-xs text-muted-foreground mt-1">The page with the blue “Upload Submission” button. Open the class → click “Open” on the assignment → copy that URL.</p>
        </div>
        <div><Label>Cooldown (hours)</Label><Input type="number" min={1} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} /></div>
        <DialogFooter><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save slot"}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
