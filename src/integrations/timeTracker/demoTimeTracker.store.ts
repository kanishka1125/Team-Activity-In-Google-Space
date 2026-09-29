import { randomUUID } from "node:crypto";

export interface DemoTimeEntry {
  id: string;
  name: string;
  email: string;
  project: string;
  note: string;
  startTime: string;
  endTime: string;
  dateSubmitted: string;
  totalHours: number;
  isOnLeave: boolean;
  isAuto: boolean;
  actionBy: string;
}

class DemoTimeTrackerStore {
  private readonly entries: DemoTimeEntry[] = [];

  getEntries(): DemoTimeEntry[] {
    return [...this.entries];
  }

  getTodayEntry(email: string): DemoTimeEntry | undefined {
    const today = new Date().toISOString().slice(0, 10);

    return this.entries
      .filter(
        (entry) =>
          entry.email.toLowerCase() === email.toLowerCase() &&
          entry.dateSubmitted === today,
      )
      .sort(
        (a, b) =>
          new Date(b.startTime).getTime() -
          new Date(a.startTime).getTime(),
      )[0];
  }

  getActiveEntry(email: string): DemoTimeEntry | undefined {
    return this.entries.find(
      (entry) =>
        entry.email.toLowerCase() === email.toLowerCase() &&
        entry.endTime === "" &&
        !entry.isOnLeave,
    );
  }

  start(
    name: string,
    email: string,
    project: string,
    note = "",
  ): DemoTimeEntry {
    const now = new Date();

    const existing = this.getActiveEntry(email);

    if (existing) {
      this.stop(email, now);
    }

    const entry: DemoTimeEntry = {
      id: randomUUID(),
      name,
      email,
      project,
      note,
      startTime: now.toISOString(),
      endTime: "",
      dateSubmitted: now.toISOString().slice(0, 10),
      totalHours: 0,
      isOnLeave: false,
      isAuto: false,
      actionBy: name,
    };

    this.entries.push(entry);

    return { ...entry };
  }

  stop(
    email: string,
    endTime = new Date(),
  ): DemoTimeEntry | undefined {
    const entry = this.getActiveEntry(email);

    if (!entry) {
      return undefined;
    }

    entry.endTime = endTime.toISOString();

    const start = new Date(entry.startTime).getTime();
    const end = endTime.getTime();

    entry.totalHours = Number(
      Math.max(0, (end - start) / 3_600_000).toFixed(2),
    );

    return { ...entry };
  }

  markOnLeave(
    name: string,
    email: string,
  ): DemoTimeEntry {
    const existing = this.getActiveEntry(email);

    if (existing) {
      this.stop(email);
    }

    const entry: DemoTimeEntry = {
      id: randomUUID(),
      name,
      email,
      project: "On Leave",
      note: "Automatically marked by AIOS",
      startTime: "",
      endTime: "",
      dateSubmitted: new Date()
        .toISOString()
        .slice(0, 10),
      totalHours: 0,
      isOnLeave: true,
      isAuto: true,
      actionBy: "AIOS",
    };

    this.entries.push(entry);

    return { ...entry };
  }
}

export const demoTimeTrackerStore =
  new DemoTimeTrackerStore();