// Task shape returned by the existing PMS Tasks API (same fields the
// AIOS backend uses in apps/backend/src/integrations/pms/pms.types.ts).
// Only what this service reads is declared. READ-ONLY.
export interface PmsSubtask {
  name?: string;
  assignee?: string;
  status?: string;
  dueDate?: string;
}

export interface PmsTask {
  id: string;
  projectId?: string;
  name?: string;
  // Assignee email.
  assignee: string;
  // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (no time zone), or empty.
  dueDate: string;
  // Seen in live data: Backlog, To Do, In Progress, Done, Closed.
  status: string;
  subs?: PmsSubtask[];
}
