import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Download, RotateCw, X, Trash2, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./status-badge";
import {
  ACTIVE_STATUSES, cancelJob, deleteJob, downloadReport, retryJob,
  type Job,
} from "@/lib/jobs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function JobsTable({
  jobs,
  showUser = false,
  onChange,
}: {
  jobs: (Job & { user?: { email: string } | null })[];
  showUser?: boolean;
  onChange?: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Job | null>(null);

  async function handleDownload(j: Job) {
    setPending(j.id);
    const url = await downloadReport(j.id);
    setPending(null);
    if (!url) return toast.error("Report unavailable");
    window.open(url, "_blank");
  }

  async function handleRetry(j: Job) {
    setPending(j.id);
    const { error } = await retryJob(j.id);
    setPending(null);
    if (error) toast.error(error.message); else { toast.success("Re-queued"); onChange?.(); }
  }

  async function handleCancel(j: Job) {
    setPending(j.id);
    const { error } = await cancelJob(j.id);
    setPending(null);
    if (error) toast.error(error.message); else { toast.success("Cancelled"); onChange?.(); }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setPending(toDelete.id);
    const { error } = await deleteJob(toDelete.id, toDelete.source_path);
    setPending(null);
    setToDelete(null);
    if (error) toast.error(error.message); else { toast.success("Deleted"); onChange?.(); }
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card/40 p-12 text-center">
        <FileText className="mx-auto h-10 w-10 text-muted-foreground/60" />
        <p className="mt-3 text-sm text-muted-foreground">No jobs yet</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Document</th>
              {showUser && <th className="px-4 py-3 font-medium">User</th>}
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((j) => {
              const active = ACTIVE_STATUSES.includes(j.status);
              const busy = pending === j.id;
              return (
                <tr key={j.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{j.original_name}</span>
                    </div>
                    {j.error && <div className="mt-1 text-xs text-destructive truncate max-w-md">{j.error}</div>}
                  </td>
                  {showUser && <td className="px-4 py-3 text-muted-foreground">{j.user?.email ?? "—"}</td>}
                  <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(j.created_at), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {j.status === "completed" && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleDownload(j)}>
                          <Download className="h-4 w-4" />
                        </Button>
                      )}
                      {j.status === "failed" && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleRetry(j)}>
                          <RotateCw className="h-4 w-4" />
                        </Button>
                      )}
                      {active && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleCancel(j)}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setToDelete(j)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
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
            <AlertDialogTitle>Delete this job?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the source document and all related records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
