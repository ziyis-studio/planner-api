export type HabitInsightDay = {
  date: string;
  planned: number;
  completed: number;
  needsMaterialization: boolean;
  level: number;
  actualDates: string[];
};
export type HabitInsights = {
  kind: "habits";
  from: string;
  to: string;
  today: string;
  completed: number;
  planned: number;
  percentage: number;
  perfectDays: number;
  activeDays: number;
  currentStreak: number;
  bestStreak: number;
  streakHabit: string | null;
  daily: HabitInsightDay[];
  trail: HabitInsightDay[];
  habits: {
    id: string;
    completed: number;
    planned: number;
    currentStreak: number;
    bestStreak: number;
    days: HabitInsightDay[];
  }[];
};
export type SleepInsightDay = {
  date: string;
  minutes: number;
  entries: number;
  awake: number;
  inBed: number;
};
export type SleepInsights = {
  kind: "sleep";
  from: string;
  to: string;
  today: string;
  days: SleepInsightDay[];
  average: number | null;
  loggedDays: number;
  elapsedDays: number;
  shortest: number | null;
  longest: number | null;
  rhythm: {
    bedtime: string;
    wakeTime: string;
    variation: number;
    samples: number;
  } | null;
  recent:
    | (SleepInsightDay & {
        bedtime: string;
        wakeTime: string;
        difference: number | null;
        records: {
          id: string;
          startsAt: string;
          endsAt: string;
          minutes: number;
          awake: number;
        }[];
      })
    | null;
};
