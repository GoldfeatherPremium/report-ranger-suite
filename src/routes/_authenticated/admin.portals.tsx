import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2, Pencil, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/admin/portals")({ component: PortalsPage });

type Portal = {
  id: string;
  name: string;
  base_url: string;
  selectors: Record<string, unknown>;
  timeout_ms: number;
  is_active: boolean;
};

const empty = { name: "", base_url: "", selectors: "{}", timeout_ms: 180000, is_active: true };

function PortalsPage() {
  const { data = [], refetch, isLoading } = useQuery({
    queryKey: ["portals"],
    queryFn: async () => {
      const { data, error } = await supabase.from("portal_configs").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Portal[];
    },
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Portal | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);

  function openNew() { setEditing(null); setForm(empty); setOpen(true); }
  function openEdit(p: Portal) {
    setEditing(p);
    setForm({
      name: p.name, base_url: p.base_url,
      selectors: JSON.stringify(p.selectors, null, 2),
      timeout_ms: p.timeout_ms, is_active: p.is_active,
    });
    setOpen(true);
  }

  async function save() {
    let selectors: unknown;
    try { selectors = JSON.parse(form.selectors); }
    catch { return toast.error("Selectors must be valid JSON"); }
    setBusy(true);
    const payload = {
      name: form.name, base_url: form.base_url, selectors: selectors as Json,
      timeout_ms: Number(form.timeout_ms), is_active: form.is_active,
    };
    const { error } = editing
      ? await supabase.from("portal_configs").update(payload).eq("id", editing.id)
      : await supabase.from("portal_configs").insert(payload);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(editing ? "Updated" : "Created");
    setOpen(false); refetch();
  }

  async function remove(p: Portal) {
    if (!confirm(`Delete "${p.name}"?`)) return;
    const { error } = await supabase.from("portal_configs").delete().eq("id", p.id);
    if (error) toast.error(error.message); else { toast.success("Deleted"); refetch(); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Portal configurations</h2>
          <p className="mt-1 text-sm text-muted-foreground">Define the external portals the worker drives.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New portal</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{editing ? "Edit portal" : "New portal"}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Base URL</Label>
                <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://portal.example.com" />
              </div>
              <div className="space-y-2">
                <Label>Selectors (JSON)</Label>
                <Textarea
                  rows={6} className="font-mono text-xs"
                  value={form.selectors}
                  onChange={(e) => setForm({ ...form, selectors: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Timeout (ms)</Label>
                  <Input type="number" value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Active</Label>
                  <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Base URL</th>
                <th className="px-4 py-3 text-right">Timeout</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No portals yet</td></tr>
              )}
              {data.map((p) => (
                <tr key={p.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground truncate max-w-xs">{p.base_url}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.timeout_ms.toLocaleString()} ms</td>
                  <td className="px-4 py-3">
                    <span className={p.is_active ? "text-success" : "text-muted-foreground"}>
                      {p.is_active ? "Yes" : "No"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(p)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
