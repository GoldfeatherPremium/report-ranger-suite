import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import type { JobStatus } from "@/lib/jobs";

export const Route = createFileRoute("/_authenticated/admin/users")({ component: AdminUsers });

function AdminUsers() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const { data: users, error } = await supabase
        .from("users").select("id, email, full_name, role, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const { data: jobs } = await supabase.from("jobs").select("user_id, status");
      const counts = new Map<string, { total: number; active: number; failed: number }>();
      ((jobs ?? []) as { user_id: string; status: JobStatus }[]).forEach((j) => {
        const c = counts.get(j.user_id) ?? { total: 0, active: 0, failed: 0 };
        c.total++;
        if (["pending", "queued", "processing"].includes(j.status)) c.active++;
        if (j.status === "failed") c.failed++;
        counts.set(j.user_id, c);
      });
      return (users ?? []).map((u) => ({ ...u, counts: counts.get(u.id) ?? { total: 0, active: 0, failed: 0 } }));
    },
  });

  if (isLoading || !data) return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Users</h2>
        <p className="mt-1 text-sm text-muted-foreground">{data.length} total</p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3 text-right">Jobs</th>
              <th className="px-4 py-3 text-right">Active</th>
              <th className="px-4 py-3 text-right">Failed</th>
              <th className="px-4 py-3">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((u) => (
              <tr key={u.id} className="hover:bg-muted/20">
                <td className="px-4 py-3">
                  <div className="font-medium">{u.full_name || u.email}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </td>
                <td className="px-4 py-3"><span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs capitalize">{u.role}</span></td>
                <td className="px-4 py-3 text-right tabular-nums">{u.counts.total}</td>
                <td className="px-4 py-3 text-right tabular-nums text-info">{u.counts.active}</td>
                <td className="px-4 py-3 text-right tabular-nums text-destructive">{u.counts.failed}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDistanceToNow(new Date(u.created_at), { addSuffix: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
