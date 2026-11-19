import { emptyWorkspace } from "./domain/model";
import { applyCommand } from "./domain/commands";
import type { Command } from "./domain/commands";
import type { Workspace } from "./domain/model";
import { addDays, dayKey, timeKey, wallTime } from "./domain/time";

export function createDemo(zone: string): Workspace {
  let state = emptyWorkspace();
  const today = dayKey(new Date(), zone);
  const run = (command: Command) => {
    const result = applyCommand(state, command);
    state = result.snapshot;
    return result.id!;
  };
  const product = run({
    type: "project.create",
    input: {
      title: "ONE Workspace",
      description: "A little space for everything that matters.",
      icon: "sparkles",
      tags: ["Product"],
    },
  });
  const life = run({
    type: "project.create",
    input: {
      title: "A slower kind of Sunday",
      description: "Make room for the things that fill you up.",
      icon: "leaf",
      tags: ["Personal"],
    },
  });
  run({
    type: "project.create",
    input: {
      title: "Reading & research",
      description: "Ideas worth coming back to.",
      icon: "book",
      tags: ["Learning"],
      workStatus: "on_hold",
    },
  });
  const task = run({
    type: "task.create",
    input: {
      title: "Refine the little details",
      description:
        "Review interactions, spacing, and the things you feel before you notice.",
      projectId: product,
      deadline: today,
      tags: ["Design"],
      conditions: ["Review the desktop layout", "Check the mobile experience"],
    },
  });
  run({ type: "task.continue", id: task });
  run({
    type: "task.create",
    input: {
      title: "Make a little room to think",
      description: "Step away from the screen. Bring a notebook.",
      projectId: life,
      deadline: today,
      tags: ["Personal"],
    },
  });
  const done = run({
    type: "task.create",
    input: {
      title: "Plan an intentional week",
      projectId: life,
      deadline: today,
      tags: ["Planning"],
    },
  });
  run({ type: "task.complete", id: done });
  run({
    type: "task.create",
    input: {
      title: "Explore a new direction",
      description: "Collect a few references for the next chapter.",
      projectId: product,
      deadline: addDays(today, 2),
      tags: ["Research"],
    },
  });
  for (const [title, icon] of [
    ["Read a few pages", "book"],
    ["Move your body", "fitness"],
    ["Write a little", "journal"],
  ] as const) {
    run({
      type: "habit.create",
      input: {
        title,
        description: "",
        icon,
        startsOn: addDays(today, -30),
        timeZone: zone,
        isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
  }
  run({
    type: "occurrences.materialize",
    from: addDays(today, -14),
    to: addDays(today, 7),
  });
  for (const [index, occurrence] of state.occurrences.entries())
    if (
      (occurrence.plannedOn < today && index % 4 !== 0) ||
      (occurrence.plannedOn === today &&
        occurrence.habitId === state.habits[0].id)
    )
      run({
        type: "execution.record",
        occurrenceId: occurrence.id,
        performedOn: occurrence.plannedOn,
      });
  for (const [title, start, end] of [
    ["A little deep work", "09:00", "10:30"],
    ["Take a proper break", "12:00", "13:00"],
    ["Build something meaningful", "14:00", "16:00"],
    ["Time to unwind", "18:00", "19:00"],
  ])
    run({
      type: "block.save",
      input: {
        title,
        startsAt: wallTime(today, start, zone),
        endsAt: wallTime(today, end, zone),
        timeZone: zone,
      },
    });
  const lastWakeDay =
    timeKey(new Date(), zone) >= "07:20" ? today : addDays(today, -1);
  for (let index = 6; index >= 0; index--) {
    const day = addDays(lastWakeDay, -index);
    run({
      type: "sleep.save",
      input: {
        startsAt: wallTime(
          addDays(day, -1),
          ["23:10", "23:40", "22:50", "23:30", "22:40", "23:00", "23:15"][
            index
          ],
          zone,
        ),
        endsAt: wallTime(day, "07:20", zone),
        awakeMinutes: 15,
        timeZone: zone,
      },
    });
  }
  run({
    type: "thought.create",
    input: {
      content:
        "What if being productive meant making more space, rather than filling it?",
      emotion: "Curious",
      recordedAt: new Date(Date.now() - 17 * 60000).toISOString(),
    },
  });
  run({
    type: "thought.create",
    input: {
      content: "The best ideas usually arrive when I stop looking for them.",
      emotion: "Inspired",
      recordedAt: new Date(Date.now() - 62 * 60000).toISOString(),
    },
  });
  run({
    type: "note.save",
    input: {
      title: "A few things to remember",
      content:
        "# A little clarity\n\nYou do not need to do everything today.\n\n- Make one thing a little better\n- Leave room for the unexpected\n- Notice the small wins",
      tags: ["Personal"],
      targets: [],
    },
  });
  run({
    type: "note.save",
    input: {
      title: "ONE — design principles",
      content:
        "# Thoughtfully simple\n\nClarity before decoration.\n\nA calm place to plan, reflect, and begin again.",
      tags: ["Design"],
      targets: [],
    },
  });
  run({
    type: "note.save",
    input: {
      title: "Things I want to learn",
      content:
        "A growing collection of curiosities.\n\n## This month\n- Creative coding\n- A better morning routine\n- The art of paying attention",
      tags: ["Learning"],
      targets: [],
    },
  });
  return state;
}
