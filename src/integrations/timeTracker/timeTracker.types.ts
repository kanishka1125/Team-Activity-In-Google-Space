export interface RawTimeTrackerEntry {
  rowIndex: number;
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