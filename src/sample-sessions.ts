import type { TimeBlock } from "./domain/model.js";
const POMODORO_MODES = {
  focus: { label: "Focus" },
  short: { label: "Short break" },
  long: { label: "Long break" },
};
type PomodoroRecord = {
  id: string;
  mode: "focus" | "short" | "long";
  startedAt: number;
  completedAt: number;
  durationSeconds: number;
  taskId?: string | null;
  taskTitle?: string;
};

/** The sample mirrors the database's automatic completion-to-time-block mapping. */
export function pomodoroTimeBlock(
  record: PomodoroRecord,
  zone: string,
): TimeBlock {
  const elapsedMinutes = (record.completedAt - record.startedAt) / 60_000;
  const pausedMinutes = Math.max(
    0,
    elapsedMinutes - record.durationSeconds / 60,
  );
  const stamp = new Date(record.completedAt).toISOString();
  return {
    id: record.id,
    title:
      record.mode === "focus" && record.taskTitle
        ? record.taskTitle
        : `Pomodoro · ${POMODORO_MODES[record.mode].label}`,
    recordedType: record.mode,
    sourceSessionId: record.id,
    description: `${record.mode === "focus" ? "Focus" : "Break"} time: ${record.durationSeconds / 60} min\nElapsed: ${Math.round(elapsedMinutes * 10) / 10} min\nPaused: ${Math.round(pausedMinutes * 10) / 10} min\nAutomatically recorded from Pomodoro.`,
    startsAt: new Date(record.startedAt).toISOString(),
    endsAt: stamp,
    timeZone: zone,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
