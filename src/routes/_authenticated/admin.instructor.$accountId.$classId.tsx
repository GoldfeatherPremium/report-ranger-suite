import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Plus, Trash2, Power } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin/instructor/$accountId/$classId")({ component: Page });

type Assignment = {
  id: string; class_id: string; label: string; submit_url: string | null;
  cooldown_hours: number; is_active: boolean; created_at: string;
  last_used_at?: string | null;
};

function Page() {
  const { accountId, classId } = Route.useParams();
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Assignment | null>(null);

  const { data: cls } = useQuery({
    queryKey: ["turnitin_instructor_class", classId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_instructor_classes" as never)
        .select("id,label")
        .eq("id", classId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as { id: string; label: string } | null;
    },
  });

  const { data: assignments = [], refetch } = useQuery({
    queryKey: ["turnitin_instructor_assignments", classId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_instructor_assignments" as never)
        .select("id,class_id,label,submit_url,cooldown_hours,is_active,created_at")
        .eq("class_id", classId)
        .order("created_at");
      if (error) throw error;
      const rows = (data ?? []) as unknown as Assignment[];
      if (rows.length) {
        const ids = rows.map((x) => x.id);
        const { data: usages } = await supabase
          .from("turnitin_instructor_slot_usage" as never)
          .select("assignment_id,submitted_at")
          .in("assignment_id", ids)
          .order("submitted_at", { ascending: false });
        const latest = new Map<string, string>();
        ((usages ?? []) as unknown as { assignment_id: string; submitted_at: string }[])
          .forEach((u) => { if (!latest.has(u.assignment_id)) latest.set(u.assignment_id, u.submitted_at); });
        rows.forEach((x) => { x.last_used_at = latest.get(x.id) ?? null; });
      }
      return rows;
    },
  });

  async function toggleActive(a: Assignment) {
    const { error } = await supabase
      .from("turnitin_instructor_assignments" as never)
      .update({ is_active: !a.is_active } as never)
      .eq("id", a.id);
    if (error) toast.error(error.message); else refetch();
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const { error } = await supabase
      .from("turnitin_instructor_assignments" as never)
      .delete()
      .eq("id", toDelete.id);
    setToDelete(null);
    if (error) toast.error(error.message); else { toast.success("Assignment deleted"); refetch(); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/instructor/$accountId" params={{ accountId }}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {cls?.label ?? "Class"}
        </Link>
      </Button>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">{cls?.label ?? "Class"} — Assignments</h2>
          <p className="text-sm text-muted-foreground">Each assignment is a bookable submission slot.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Add assignment</Button></DialogTrigger>
          <AddAssignmentDialog classId={classId} onDone={() => { setOpen(false); refetch(); }} />
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
            {assignments.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No assignments yet.</td></tr>}
            {assignments.map((a) => {
              const free = !a.last_used_at || (Date.now() - new Date(a.last_used_at).getTime()) > a.cooldown_hours * 3_600_000;
              return (
                <tr key={a.id} className="border-b last:border-0 hover:bg-accent/30">
                  <td className="px-4 py-3 font-medium">{a.label}</td>
                  <td className="px-4 py-3 truncate text-xs text-muted-foreground max-w-xs">{a.submit_url || "—"}</td>
                  <td className="px-4 py-3">{a.cooldown_hours}h</td>
                  <td className="px-4 py-3">
                    {!a.is_active ? (
                      <span className="text-xs text-muted-foreground">Disabled</span>
                    ) : free ? (
                      <span className="text-xs text-success">Free now</span>
                    ) : (
                      <span className="text-xs text-warning">Used {formatDistanceToNow(new Date(a.last_used_at!))} ago</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="icon" onClick={() => toggleActive(a)} title="Toggle"><Power className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => setToDelete(a)} title="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete assignment "{toDelete?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddAssignmentDialog({ classId, onDone }: { classId: string; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [submitUrl, setSubmitUrl] = useState("");
  const [cooldown, setCooldown] = useState(24);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label) { toast.error("Label is required"); return; }
    setSaving(true);
    const { error } = await supabase
      .from("turnitin_instructor_assignments" as never)
      .insert({ class_id: classId, label, submit_url: submitUrl || null, cooldown_hours: cooldown } as never);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Assignment added"); onDone();
  }

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Add assignment</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Essay #1" /></div>
        <div>
          <Label>Assignment URL</Label>
          <Input
            value={submitUrl}
            onChange={(e) => setSubmitUrl(e.target.value)}
            placeholder="https://www.turnitin.com/assignment/type/tool/launch?cid=…&ut=instructor&lang=en_us"
          />
          <p className="text-xs text-muted-foreground mt-1">
            In Turnitin: open the class → click <strong>View</strong> on the assignment → copy the full URL from the address bar.
            The worker logs in and navigates here directly — no other steps.
          </p>
        </div>
        <div><Label>Cooldown (hours)</Label><Input type="number" min={1} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} /></div>
        <DialogFooter><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save assignment"}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
