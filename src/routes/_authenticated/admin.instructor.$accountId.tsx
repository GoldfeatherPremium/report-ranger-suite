import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
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
import { ArrowLeft, Plus, Trash2, Power, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/instructor/$accountId")({ component: Page });

type Class = {
  id: string; account_id: string; label: string; class_url: string | null;
  is_active: boolean; created_at: string;
};

function Page() {
  const { accountId } = Route.useParams();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isAssignmentRoute = pathname.startsWith(`/admin/instructor/${accountId}/`);
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Class | null>(null);

  const { data: account } = useQuery({
    queryKey: ["turnitin_instructor_account", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_instructor_accounts" as never)
        .select("id,label,email")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as { id: string; label: string; email: string } | null;
    },
  });

  const { data: classes = [], refetch } = useQuery({
    queryKey: ["turnitin_instructor_classes", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_instructor_classes" as never)
        .select("id,account_id,label,class_url,is_active,created_at")
        .eq("account_id", accountId)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as Class[];
    },
  });

  async function toggleActive(c: Class) {
    const { error } = await supabase
      .from("turnitin_instructor_classes" as never)
      .update({ is_active: !c.is_active } as never)
      .eq("id", c.id);
    if (error) toast.error(error.message); else refetch();
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const { error } = await supabase
      .from("turnitin_instructor_classes" as never)
      .delete()
      .eq("id", toDelete.id);
    setToDelete(null);
    if (error) toast.error(error.message); else { toast.success("Class deleted"); refetch(); }
  }

  if (isAssignmentRoute) {
    return <Outlet />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/instructor"><ArrowLeft className="mr-1 h-4 w-4" /> All accounts</Link>
      </Button>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">{account?.label ?? "Account"} — Classes</h2>
          <p className="text-sm text-muted-foreground">{account?.email}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" /> Add class</Button></DialogTrigger>
          <AddClassDialog accountId={accountId} onDone={() => { setOpen(false); refetch(); }} />
        </Dialog>
      </div>

      <div className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Class URL</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {classes.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">No classes yet.</td></tr>}
            {classes.map((c) => (
              <tr key={c.id} className="border-b last:border-0 hover:bg-accent/30">
                <td className="px-4 py-3 font-medium">{c.label}</td>
                <td className="px-4 py-3 truncate text-xs text-muted-foreground max-w-xs">{c.class_url || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${c.is_active ? "border-success/30 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
                    <Power className="h-3 w-3" /> {c.is_active ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      navigate({
                        to: "/admin/instructor/$accountId/$classId",
                        params: { accountId, classId: c.id },
                      })
                    }
                  >
                    Assignments <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => toggleActive(c)} title="Toggle"><Power className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => setToDelete(c)} title="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete class "{toDelete?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>This also deletes all assignments inside it. This cannot be undone.</AlertDialogDescription>
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

function AddClassDialog({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [classUrl, setClassUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label) { toast.error("Label is required"); return; }
    setSaving(true);
    const { error } = await supabase
      .from("turnitin_instructor_classes" as never)
      .insert({ account_id: accountId, label, class_url: classUrl || null } as never);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Class added"); onDone();
  }

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Add class</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ENGL 101" /></div>
        <div>
          <Label>Class URL</Label>
          <Input value={classUrl} onChange={(e) => setClassUrl(e.target.value)} placeholder="https://www.turnitin.com/class/..." />
          <p className="text-xs text-muted-foreground mt-1">Optional — for reference only.</p>
        </div>
        <DialogFooter><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save class"}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
