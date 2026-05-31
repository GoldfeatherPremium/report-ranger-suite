import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Eye, EyeOff, Loader2, ShieldAlert, CheckCircle2, XCircle } from "lucide-react";
import { getWorkerCredentials } from "@/lib/admin-settings.functions";

type KeyValidation =
  | { ok: true; role: "service_role"; ref: string | null; exp: number | null }
  | { ok: false; reason: string; role?: string };

function validateServiceRoleKey(key: string): KeyValidation {
  if (!key || typeof key !== "string") return { ok: false, reason: "Key is empty" };
  const trimmed = key.trim();
  if (trimmed !== key) return { ok: false, reason: "Key has surrounding whitespace" };
  const parts = key.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "Not a JWT — looks like a publishable/anon key or placeholder" };
  }
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { role?: string; ref?: string; exp?: number };
    if (payload.role !== "service_role") {
      return { ok: false, reason: `JWT role is "${payload.role ?? "unknown"}", expected "service_role"`, role: payload.role };
    }
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: "JWT is expired", role: payload.role };
    }
    return { ok: true, role: "service_role", ref: payload.ref ?? null, exp: payload.exp ?? null };
  } catch {
    return { ok: false, reason: "JWT payload could not be decoded" };
  }
}

export const Route = createFileRoute("/_authenticated/admin/settings")({ component: Page });

function Page() {
  const fetchCreds = useServerFn(getWorkerCredentials);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "worker-credentials"],
    queryFn: () => fetchCreds(),
    enabled: false, // load on demand
    retry: false,
  });

  const [reveal, setReveal] = useState(false);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  const envBlock = data
    ? `SUPABASE_URL=${data.supabaseUrl}
SUPABASE_SERVICE_ROLE_KEY=${data.serviceRoleKey}
WORKER_ID=contabo-1
HEADLESS=true
SUBMISSION_TIMEOUT_MS=1800000
POLL_INTERVAL_MS=15000
CLAIM_IDLE_MS=10000
HEARTBEAT_MS=30000`
    : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">VPS Worker Credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use these values in the VPS worker's <code className="rounded bg-muted px-1 py-0.5">.env</code> file. Admin only.
        </p>
      </div>

      <div className="rounded-xl border bg-warning/10 border-warning/30 p-4 text-sm flex gap-3">
        <ShieldAlert className="h-5 w-5 shrink-0 text-warning" />
        <div>
          <p className="font-medium">Treat the service role key as a password.</p>
          <p className="text-muted-foreground">It bypasses all database security. Only paste it into the VPS server, never into client apps or public repos.</p>
        </div>
      </div>

      {!data && (
        <Button onClick={() => refetch()} disabled={isLoading || isFetching}>
          {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Reveal credentials
        </Button>
      )}

      {error && (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      )}

      {data && (
        <div className="space-y-5 rounded-xl border bg-card p-5">
          <div className="space-y-2">
            <Label>SUPABASE_URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={data.supabaseUrl} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={() => copy(data.supabaseUrl, "URL")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>SUPABASE_SERVICE_ROLE_KEY</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                type={reveal ? "text" : "password"}
                value={data.serviceRoleKey}
                className="font-mono text-xs"
              />
              <Button variant="outline" size="icon" onClick={() => setReveal((r) => !r)}>
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button variant="outline" size="icon" onClick={() => copy(data.serviceRoleKey, "Service role key")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Full .env for VPS worker</Label>
              <Button variant="outline" size="sm" onClick={() => copy(envBlock, ".env contents")}>
                <Copy className="mr-2 h-4 w-4" /> Copy all
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all">
{envBlock}
            </pre>
            <p className="text-xs text-muted-foreground">
              On the VPS run: <code className="rounded bg-muted px-1 py-0.5">nano /opt/dochub/vps/worker/.env</code>, paste, save, then{" "}
              <code className="rounded bg-muted px-1 py-0.5">systemctl restart turnitin-worker</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
