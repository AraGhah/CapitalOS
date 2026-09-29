// No database or server imports: the launcher in the browser reads this too.

export type Mode = "fast" | "standard" | "deep" | "committee";

export interface ModeSpec {
  id: Mode;
  label: string;
  description: string;
  // how many independent analyst seats, at most
  seats: number;
  specialists: boolean;
  debate: boolean;
  challenger: boolean;
  modelFactCheck: boolean;
  judge: boolean;
  synthesizer: boolean;
}

// Paying for five models on a small question is waste; paying for one on a
// decision is false economy. The mode is the dial between the two.
export const MODES: ModeSpec[] = [
  {
    id: "fast",
    label: "Fast",
    description: "One model, checked by code. For a quick read.",
    seats: 1,
    specialists: false,
    debate: false,
    challenger: false,
    modelFactCheck: false,
    judge: false,
    synthesizer: false,
  },
  {
    id: "standard",
    label: "Standard",
    description: "Up to three models analyse blind; code checks every figure; a synthesizer writes the result.",
    seats: 3,
    specialists: false,
    debate: false,
    challenger: false,
    modelFactCheck: false,
    judge: false,
    synthesizer: true,
  },
  {
    id: "deep",
    label: "Deep research",
    description: "Up to four models, a model fact checker, a challenger and a judge before synthesis.",
    seats: 4,
    specialists: false,
    debate: false,
    challenger: true,
    modelFactCheck: true,
    judge: true,
    synthesizer: true,
  },
  {
    id: "committee",
    label: "Investment committee",
    description: "Everything in deep research, plus six specialist seats and a bull-versus-bear debate.",
    seats: 4,
    specialists: true,
    debate: true,
    challenger: true,
    modelFactCheck: true,
    judge: true,
    synthesizer: true,
  },
];

export const SPECIALIST_COUNT = 6;

export function modeSpec(mode: Mode): ModeSpec {
  return MODES.find((m) => m.id === mode) ?? MODES[1];
}

export function isMode(value: unknown): value is Mode {
  return MODES.some((m) => m.id === value);
}

// The number of model calls a run will make with this many analyst seats,
// before any retry. Shown before a run starts, so the cost of a mode is known up
// front rather than discovered on the bill.
export function plannedCalls(mode: Mode, seats: number): number {
  const spec = modeSpec(mode);
  const n = Math.min(seats, spec.seats);
  return (
    n +
    (spec.specialists ? SPECIALIST_COUNT : 0) +
    (spec.debate ? 2 : 0) +
    (spec.challenger ? 1 : 0) +
    (spec.modelFactCheck ? 1 : 0) +
    (spec.judge ? 1 : 0) +
    (spec.synthesizer ? 1 : 0)
  );
}
