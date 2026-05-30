import { statusStyles, type JobStatus } from "@/lib/jobs";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
      statusStyles[status],
    )}>
      {status}
    </span>
  );
}
