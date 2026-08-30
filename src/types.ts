export interface AccrualEntry {
  id: string;
  vendor: string;
  amount: number;
  gl_account: string;
  accrual_date: string;
  memo: string;
}

export interface Transaction {
  id: string;
  vendor: string;
  amount: number;
  date: string;
  description: string;
}

export interface MatchResult {
  transaction_id: string;
  matched_accrual_ids: string[];
  score: number;
  reasoning: string;
}

export interface ServicePeriod {
  key: string;
  year: number;
  month: number;
  label: string;
}

export interface PeriodExtraction {
  primary: ServicePeriod[];
  contextual: ServicePeriod[];
  hasExplicitPeriod: boolean;
  explicitMultiPeriod: boolean;
}

export type CandidateKind =
  | "one-to-one"
  | "one-transaction-to-many-accruals"
  | "many-transactions-to-one-accrual"
  | "partial-multi-period";

export interface CandidateSeed {
  id: string;
  transactions: Transaction[];
  accruals: AccrualEntry[];
  kind: CandidateKind;
  amountExpected: number;
  amountExpectedRaw: number;
  periodScale: number;
  amountActual: number;
  groupingReliability: number;
  groupingReason: string;
  unresolvedResidual: number;
}

export interface ScoreBreakdown {
  vendor: number;
  amount: number;
  memo: number;
  date: number;
  glAccount: number;
  baseScore: number;
  penalty: number;
  hardCap: number;
  deterministicScore: number;
  finalScore: number;
}

export interface MatchEvidence {
  vendor: string;
  amount: string;
  memo: string;
  date: string;
  glAccount: string;
  penalties: string[];
  matchedTerms: string[];
}

export type AIReviewDecision = "support" | "neutral" | "reject";

export interface AIReview {
  status: "not-required" | "used" | "unavailable";
  trigger: string;
  decision: AIReviewDecision | null;
  adjustment: number;
  reasoning: string;
}

export interface CandidateGroup extends CandidateSeed {
  breakdown: ScoreBreakdown;
  evidence: MatchEvidence;
  score: number;
  aiReview: AIReview;
}
