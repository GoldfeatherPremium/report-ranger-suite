import { useState, useCallback, useRef } from "react";
import { Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { uploadAndCreateJob } from "@/lib/jobs";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadDropzone({ onUploaded }: { onUploaded?: () => void }) {
  const { user } = useAuth();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(async (files: FileList | null) => {
    if (!files || !user) return;
    const list = Array.from(files);
    setUploading(true);
    let done = 0;
    for (const f of list) {
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name} exceeds 50 MB limit`);
        done++; setProgress(Math.round((done / list.length) * 100));
        continue;
      }
      const { error } = await uploadAndCreateJob(user.id, f);
      if (error) toast.error(`${f.name}: ${error}`);
      else toast.success(`${f.name} queued`);
      done++; setProgress(Math.round((done / list.length) * 100));
    }
    setUploading(false);
    setProgress(0);
    onUploaded?.();
  }, [user, onUploaded]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-all",
        "hover:border-primary/60 hover:bg-accent/30",
        dragging ? "border-primary bg-accent/40" : "border-border bg-card/40",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handle(e.target.files)}
      />
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        {uploading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
      </div>
      <p className="mt-4 text-sm font-medium">
        {uploading ? "Uploading…" : "Drop documents here or click to browse"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Up to 50 MB per file</p>
      {uploading && (
        <div className="mt-4 h-1 w-full overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}
