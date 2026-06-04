import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/admin/api-clients")({
  component: ApiClientsPage,
});

type Client = {
  id: string;
  name: string;
  key_prefix: string;
  webhook_url: string | null;
  is_active: boolean;
  daily_quota: number;
  rate_limit_per_min: number;
  created_at: string;
};

function ApiClientsPage() {
  const { data: clients = [], refetch } = useQuery({
    queryKey: ["api-clients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_clients" as never)
        .select("id,name,key_prefix,webhook_url,is_active,daily_quota,rate_limit_per_min,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Client[];
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">API Clients</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Issue API keys for partner sites (e.g. plagaiscans.com) to submit documents via REST.
          </p>
        </div>
        <CreateClientDialog onCreated={refetch} />
      </div>

      <div className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Webhook</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Quota / day</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No clients yet.</td></tr>
            )}
            {clients.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3 font-mono text-xs">{c.key_prefix}…</td>
                <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[280px]">{c.webhook_url || "—"}</td>
                <td className="px-4 py-3"><ToggleActive client={c} onChange={refetch} /></td>
                <td className="px-4 py-3">{c.daily_quota}</td>
                <td className="px-4 py-3 text-right"><DeleteClient client={c} onChange={refetch} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Endpoint base URL</p>
        <code className="font-mono text-xs">
          {typeof window !== "undefined" ? `${window.location.origin}/api/public/v1` : "/api/public/v1"}
        </code>
        <p className="mt-3 text-xs text-muted-foreground">
          See <code className="font-mono">PlagaiScans_Integration_Architecture.md</code> for full request/response shapes and webhook verification.
        </p>
      </div>
    </div>
  );
}

function CreateClientDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ api_key: string; webhook_secret: string } | null>(null);

  const submit = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc("create_api_client" as never, {
      p_name: name.trim(),
      p_webhook_url: webhookUrl.trim() || null,
    } as never);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setResult(data as unknown as { api_key: string; webhook_secret: string });
    onCreated();
  };

  const reset = () => { setName(""); setWebhookUrl(""); setResult(null); };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button><KeyRound className="mr-2 h-4 w-4" /> New API client</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? "Save these credentials" : "Create API client"}</DialogTitle>
          <DialogDescription>
            {result
              ? "This is the only time you'll see the API key and webhook secret. Copy them now."
              : "Issues a long-lived API key plus a webhook signing secret for the partner site."}
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="plagaiscans" />
            </div>
            <div>
              <Label htmlFor="webhook">Webhook URL (optional)</Label>
              <Input id="webhook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                     placeholder="https://plagaiscans.com/webhooks/turnitin" />
              <p className="mt-1 text-xs text-muted-foreground">Default destination for report-ready callbacks. Can be overridden per job.</p>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <CopyField label="API key" value={result.api_key} />
            <CopyField label="Webhook secret" value={result.webhook_secret} />
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <Button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
          ) : (
            <Button onClick={() => setOpen(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input value={value} readOnly className="font-mono text-xs" />
        <Button
          type="button" variant="outline" size="icon"
          onClick={() => { navigator.clipboard.writeText(value); toast.success(`${label} copied`); }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ToggleActive({ client, onChange }: { client: Client; onChange: () => void }) {
  return (
    <Switch
      checked={client.is_active}
      onCheckedChange={async (v) => {
        const { error } = await supabase
          .from("api_clients" as never)
          .update({ is_active: v } as never)
          .eq("id", client.id);
        if (error) toast.error(error.message);
        else { toast.success(v ? "Activated" : "Deactivated"); onChange(); }
      }}
    />
  );
}

function DeleteClient({ client, onChange }: { client: Client; onChange: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-destructive">
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete API client?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{client.name}</strong> will be permanently removed. Existing jobs created with this key will remain, but no new requests will authenticate.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={async () => {
              const { error } = await supabase.from("api_clients" as never).delete().eq("id", client.id);
              if (error) toast.error(error.message);
              else { toast.success("Deleted"); onChange(); }
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
