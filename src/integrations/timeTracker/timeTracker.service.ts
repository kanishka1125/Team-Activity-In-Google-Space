import { TimeTrackerClient } from "./timeTracker.client.js";
import {
  demoTimeTrackerStore,
  type DemoTimeEntry,
} from "./demoTimeTracker.store.js";
import type { RawTimeTrackerEntry } from "./timeTracker.types.js";

export class TimeTrackerService {
  private readonly client: TimeTrackerClient;

  constructor() {
    this.client = new TimeTrackerClient();
  }

  // Existing real Time Tracker read
  async getTimeEntries(): Promise<RawTimeTrackerEntry[]> {
    return this.client.getData();
  }

  // -----------------------------
  // DEMO WRITE OPERATIONS
  // -----------------------------

  async startDemoEntry(
    name: string,
    email: string,
    project: string,
    note = "",
  ): Promise<DemoTimeEntry> {
    return demoTimeTrackerStore.start(
      name,
      email,
      project,
      note,
    );
  }

  async stopDemoEntry(
    email: string,
  ): Promise<DemoTimeEntry | undefined> {
    return demoTimeTrackerStore.stop(email);
  }

  async changeDemoProject(
    name: string,
    email: string,
    project: string,
    note = "",
  ): Promise<DemoTimeEntry> {
    return demoTimeTrackerStore.start(
      name,
      email,
      project,
      note,
    );
  }

  async markDemoOnLeave(
    name: string,
    email: string,
  ): Promise<DemoTimeEntry> {
    return demoTimeTrackerStore.markOnLeave(
      name,
      email,
    );
  }

  async getDemoEntries(): Promise<DemoTimeEntry[]> {
    return demoTimeTrackerStore.getEntries();
  }

  async getDemoTodayEntry(
    email: string,
  ): Promise<DemoTimeEntry | undefined> {
    return demoTimeTrackerStore.getTodayEntry(email);
  }

  async getDemoActiveEntry(
    email: string,
  ): Promise<DemoTimeEntry | undefined> {
    return demoTimeTrackerStore.getActiveEntry(email);
  }
}