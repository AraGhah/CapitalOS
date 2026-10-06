// Types only, so client components can import the report shape without pulling
// the database in with it.

import type { Mode } from "./modes";
import type { Check, CheckStats } from "./factcheck";
import type { Confidence, DimensionResult } from "./consensus";
import type {
  AdvocateView,
  ChallengerView,
  Disagreement,
  RuleText,
  SynthesisView,
} from "./roster";
import type { EvidenceCoverage } from "./evidence";

export interface SeatSummary {
  // "A", "B", … for analysts; the specialist id otherwise
  letter: string;
  name: string;
  modelId: string;
  modelLabel: string;
  ok: boolean;
  error: string | null;
  summary: string;
  thesis: string;
}

export interface ReportClaim {
  key: string;
  text: string;
  evidence: string[];
  seat: string;
  modelId: string;
  stage: string;
  check: Check;
  judge: { verdict: "weak" | "reject"; reason: string } | null;
}

export interface ModelScorecard {
  letter: string;
  modelId: string;
  modelLabel: string;
  claims: number;
  verified: number;
  failed: number;
  accuracy: number | null;
  evidenceRate: number | null;
  grades: Record<string, number>;
  overall: number | null;
}

export interface RunCost {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  unpriced: number;
  seconds: number;
}

export interface ConsensusReport {
  version: 1;
  ticker: string;
  name: string;
  mode: Mode;
  focus: string | null;
  analysts: SeatSummary[];
  specialists: SeatSummary[];
  dimensions: DimensionResult[];
  synthesis: SynthesisView | null;
  // "synthesizer" when a model wrote it; "analyst" when a fast run passed the
  // single analyst's view through
  synthesisBy: { kind: "synthesizer" | "analyst"; modelId: string; modelLabel: string } | null;
  // figures in the conclusion that the checker still could not find after the
  // synthesizer was sent back to correct them
  unverifiedFigures: string[];
  claims: ReportClaim[];
  debate: {
    bull: (AdvocateView & { modelLabel: string }) | null;
    bear: (AdvocateView & { modelLabel: string }) | null;
  };
  challenger: (ChallengerView & { modelLabel: string }) | null;
  disagreements: Disagreement[];
  criticalUncertainty: string | null;
  checks: CheckStats;
  confidence: Confidence;
  scorecards: ModelScorecard[];
  // invalidation conditions that are complete rules, which is what a thesis
  // can be opened on
  adoptableRules: RuleText[];
  // the model that first proposed each of synthesis.assumptions, index for
  // index, so the long-run record of which assumptions held is kept against
  // the model that made them rather than the one that wrote the summary
  assumptionAuthors?: Array<string | null>;
  coverage: EvidenceCoverage;
  cost: RunCost;
  degraded: string[];
}

export interface RunSummary {
  id: string;
  ticker: string;
  name: string;
  mode: Mode;
  focus: string | null;
  status: "running" | "done" | "failed";
  createdAt: string;
  confidence: number | null;
  headline: string | null;
  costUsd: number | null;
  error: string | null;
}
