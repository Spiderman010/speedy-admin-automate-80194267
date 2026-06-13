import { useState } from "react";

export function useDeleteConfirm() {
  const [pendingId, setPendingId] = useState<string | null>(null);

  return {
    open: pendingId !== null,
    pendingId,
    request: (id: string) => setPendingId(id),
    cancel: () => setPendingId(null),
  };
}
