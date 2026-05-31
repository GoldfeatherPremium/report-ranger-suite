import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Plus, ChevronRight, Power } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/turnitin/")({ component: Page });

type Account = {
  id: string; label: string; email: string; login_url: string;
  notes: string | null; is_active: boolean; created_at: string;
};

function Page() {
  const [open, setOpen] = useState(false);
  const { data: accounts = [], refetch } = useQuery({
    queryKey: ["turnitin_accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turnitin_accounts" as never)
        .select("id,label,email,login_url,notes,is_active,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Account[];
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Turnitin Accounts</h2>
          <p className="text-sm text-muted-foreground">Manage student accounts the VPS worker uses to submit documents.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> Add account</Button>
          </DialogTrigger>
          <AddAccountDialog onDone={() => { setOpen(false); refetch(); }} />
        </Dialog>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">No accounts yet.</td></tr>
            )}
            {accounts.map((a) => (
              <tr key={a.id} className="border-b last:border-0 hover:bg-accent/30">
                <td className="px-4 py-3 font-medium">{a.label}</td>
                <td className="px-4 py-3 text-muted-foreground">{a.email}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${a.is_active ? "border-success/30 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
                    <Power className="h-3 w-3" /> {a.is_active ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/admin/turnitin/$accountId" params={{ accountId: a.id }}>
                      Slots <ChevronRight className="ml-1 h-4 w-4" />
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddAccountDialog({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginUrl, setLoginUrl] = useState("https://www.turnitin.com/login_page.asp?lang=en_us");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label || !email || !password) { toast.error("Label, email and password are required"); return; }
    setSaving(true);
    // Encrypt via SQL function over RPC — but RPC requires the function to be callable.
    // Simpler approach: call an RPC `add_turnitin_account` that encrypts server-side.
    const { error } = await supabase.rpc("add_turnitin_account" as never, {
      p_label: label, p_email: email, p_password: password, p_login_url: loginUrl, p_notes: notes || null,
    } as never);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Account added");
    onDone();
  }

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Add Turnitin account</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Student #1" /></div>
        <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <div><Label>Login URL</Label><Input value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} /></div>
        <div><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></div>
        <DialogFooter>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save account"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
