export const MIN_FOCUS_MINUTES = 1;
export const MAX_FOCUS_MINUTES = 180;
export function validSessionDuration(mode: string, seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    (mode === "focus"
      ? seconds >= MIN_FOCUS_MINUTES * 60 &&
        seconds <= MAX_FOCUS_MINUTES * 60 &&
        seconds % 60 === 0
      : mode === "short"
        ? seconds === 300
        : mode === "long" && seconds === 900)
  );
}
