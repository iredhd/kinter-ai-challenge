import { matchingConfig } from "../config.js";
import type {
  AIReview,
  CandidateGroup,
  CandidateSeed,
  MatchEvidence,
  ScoreBreakdown,
} from "../types.js";
import { clamp, round } from "../utils/number.js";
import { compareCandidatePeriods } from "./periods.js";
import { compareNarratives, compareVendors, normalizeText } from "./text.js";

interface ComponentResult {
  score: number;
  explanation: string;
  matchedTerms: string[];
}

const glossary = matchingConfig.glGlossary as Record<string, readonly string[]>;
const glossaryTermOwners = new Map<string, number>();

for (const terms of Object.values(glossary)) {
  for (const term of terms) {
    glossaryTermOwners.set(term, (glossaryTermOwners.get(term) ?? 0) + 1);
  }
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function capitalize(value: string): string {
  const first = value[0];

  return first === undefined ? value : `${first.toUpperCase()}${value.slice(1)}`;
}

function uniqueList(values: string[]): string {
  return [...new Set(values)].join(", ");
}

function calculateVendorComponent(seed: CandidateSeed): ComponentResult {
  const comparisons = seed.accruals.flatMap((accrual) =>
    seed.transactions.map((transaction) =>
      compareVendors(
        accrual.vendor,
        accrual.memo,
        transaction.vendor,
        transaction.description,
      ),
    ),
  );
  const transactionCount = seed.transactions.length;
  const accrualBestScores = seed.accruals.map((_, accrualIndex) =>
    Math.max(
      ...seed.transactions.map(
        (__, transactionIndex) =>
          comparisons[accrualIndex * transactionCount + transactionIndex]
            ?.score ?? 0,
      ),
    ),
  );
  const transactionBestScores = seed.transactions.map((_, transactionIndex) =>
    Math.max(
      ...seed.accruals.map(
        (__, accrualIndex) =>
          comparisons[accrualIndex * transactionCount + transactionIndex]
            ?.score ?? 0,
      ),
    ),
  );
  const score = round(
    average([average(accrualBestScores), average(transactionBestScores)]),
  );
  const bestComparison = [...comparisons].sort(
    (left, right) => right.score - left.score,
  )[0];
  const accrualVendors = uniqueList(
    seed.accruals.map((accrual) => accrual.vendor),
  );
  const transactionVendors = uniqueList(
    seed.transactions.map((transaction) => transaction.vendor),
  );
  const basis =
    bestComparison?.matchedVia === "acronym"
      ? ", recognized through an acronym"
      : bestComparison?.matchedVia === "narrative"
        ? ", recognized from the memo or description text"
        : "";

  return {
    score,
    explanation: `vendor names agree at ${Math.round(
      score * 100,
    )}% (${transactionVendors} versus ${accrualVendors})${basis}`,
    matchedTerms: [],
  };
}

function calculateAmountComponent(seed: CandidateSeed): ComponentResult {
  const expected = seed.amountExpected;
  const actual = seed.amountActual;
  const sameDirection =
    expected === 0 || actual === 0 || Math.sign(expected) === Math.sign(actual);
  let rawScore = 0;

  if (sameDirection && expected !== 0 && actual !== 0) {
    rawScore = Math.exp(
      -matchingConfig.amount.decay *
        Math.abs(Math.log(Math.abs(actual) / Math.abs(expected))),
    );
  } else if (expected === 0 && actual === 0) {
    rawScore = 1;
  }

  const score = round(rawScore * seed.groupingReliability);
  const denominator = Math.max(Math.abs(expected), Number.EPSILON);
  const variance = Math.abs(actual - expected) / denominator;
  const comparison =
    seed.periodScale === 1
      ? `${formatCurrency(actual)} invoiced versus ${formatCurrency(
          expected,
        )} accrued`
      : `${formatCurrency(actual)} invoiced versus ${formatCurrency(
          seed.amountExpectedRaw,
        )} accrued scaled by ${seed.periodScale}x to ${formatCurrency(
          expected,
        )} for the periods the invoice covers`;

  return {
    score,
    explanation: `${comparison}, a ${(variance * 100).toFixed(
      1,
    )}% difference; ${seed.groupingReason}`,
    matchedTerms: [],
  };
}

function calculateMemoComponent(seed: CandidateSeed): ComponentResult {
  const comparisons = seed.accruals.flatMap((accrual) => {
    const ranked = seed.transactions
      .map((transaction) =>
        compareNarratives(
          accrual.memo,
          transaction.description,
          accrual.vendor,
          transaction.vendor,
        ),
      )
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];

    return best === undefined ? [] : [best];
  });
  const score = round(average(comparisons.map((comparison) => comparison.score)));
  const matchedTerms = [
    ...new Set(comparisons.flatMap((comparison) => comparison.matchedTerms)),
  ].sort();

  return {
    score,
    explanation:
      matchedTerms.length > 0
        ? `memo and description agree on ${matchedTerms.join(", ")}`
        : "memo and description share no distinctive wording, so narrative evidence is neutral",
    matchedTerms,
  };
}

function calculateGlComponent(seed: CandidateSeed): ComponentResult {
  const { tiers, strongHitCount } = matchingConfig.glAccount;
  // Only the description is compared. Including the vendor name would let a
  // vendor such as "Sterling Consulting Group" corroborate GL 6300 by itself,
  // double-counting evidence already scored by the vendor component.
  const descriptionTokens = new Set(
    normalizeText(
      seed.transactions
        .map((transaction) => transaction.description)
        .join(" "),
    ).split(" "),
  );
  const scores: number[] = [];
  const matchedTerms: string[] = [];
  const conflictingTerms: string[] = [];
  const accountIds: string[] = [];

  for (const accrual of seed.accruals) {
    const accountId = accrual.gl_account.match(/^\s*(6\d{3})/)?.[1];

    if (accountId === undefined) {
      scores.push(tiers.neutral);
      continue;
    }

    accountIds.push(accountId);
    const hits = (glossary[accountId] ?? []).filter((term) =>
      descriptionTokens.has(normalizeText(term)),
    );
    matchedTerms.push(...hits);

    if (hits.length >= strongHitCount) {
      scores.push(tiers.strong);
      continue;
    }

    if (hits.length === 1) {
      scores.push(tiers.supported);
      continue;
    }

    // Only a term unique to another category signals a genuine miscategorization.
    // A term several categories share carries no discriminating information.
    const exclusiveConflicts = Object.entries(glossary)
      .filter(([otherAccountId]) => otherAccountId !== accountId)
      .flatMap(([, terms]) =>
        terms.filter(
          (term) =>
            (glossaryTermOwners.get(term) ?? 0) === 1 &&
            descriptionTokens.has(normalizeText(term)),
        ),
      );

    conflictingTerms.push(...exclusiveConflicts);
    scores.push(
      exclusiveConflicts.length > 0 ? tiers.conflict : tiers.neutral,
    );
  }

  const uniqueTerms = [...new Set(matchedTerms)].sort();
  const uniqueConflicts = [...new Set(conflictingTerms)].sort();
  const accountLabel = uniqueList(accountIds) || "account";
  const score = round(average(scores));
  let explanation = `GL ${accountLabel} has neutral keyword support`;

  if (uniqueTerms.length > 0) {
    explanation = `GL ${accountLabel} is supported by ${uniqueTerms.join(", ")}`;
  } else if (uniqueConflicts.length > 0) {
    explanation = `GL ${accountLabel} conflicts with ${uniqueConflicts.join(
      ", ",
    )}, which belongs to another category`;
  }

  return {
    score,
    explanation,
    matchedTerms: uniqueTerms,
  };
}

function confidenceBand(score: number): string {
  const band = matchingConfig.confidenceBands.find(
    (candidate) => score >= candidate.minimum,
  );

  return band?.label ?? "Weak";
}

export function scoreCandidate(seed: CandidateSeed): CandidateGroup {
  const vendor = calculateVendorComponent(seed);
  const amount = calculateAmountComponent(seed);
  const memo = calculateMemoComponent(seed);
  const period = compareCandidatePeriods(seed.accruals, seed.transactions);
  const glAccount = calculateGlComponent(seed);
  const baseScore = round(
    matchingConfig.weights.vendor * vendor.score +
      matchingConfig.weights.amount * amount.score +
      matchingConfig.weights.memo * memo.score +
      matchingConfig.weights.date * period.score +
      matchingConfig.weights.glAccount * glAccount.score,
  );
  const penalties: string[] = [];
  let penalty = 0;
  let hardCap = 1;

  if (period.periodConflict) {
    penalty += matchingConfig.penalties.periodConflict;
    hardCap = Math.min(hardCap, matchingConfig.caps.periodConflict);
    penalties.push("the stated service periods conflict");
  }

  const residualRatio =
    Math.abs(seed.amountActual) === 0
      ? 0
      : Math.abs(seed.unresolvedResidual) / Math.abs(seed.amountActual);

  if (residualRatio > matchingConfig.thresholds.materialResidualRatio) {
    penalty += matchingConfig.penalties.unresolvedResidual;
    hardCap = Math.min(hardCap, matchingConfig.caps.unresolvedResidual);
    penalties.push(
      `${formatCurrency(
        seed.unresolvedResidual,
      )} of the invoice remains unallocated`,
    );
  }

  if (vendor.score < matchingConfig.thresholds.weakVendor) {
    hardCap = Math.min(hardCap, matchingConfig.caps.weakVendor);
    penalties.push("vendor evidence is weak");
  }

  if (
    amount.score < matchingConfig.thresholds.weakAmount &&
    seed.kind !== "partial-multi-period"
  ) {
    hardCap = Math.min(hardCap, matchingConfig.caps.weakAmount);
    penalties.push("amount evidence is weak without documented aggregation");
  }

  // The accountant's rule: automatic matching requires both vendor and amount
  // above 0.65. Falling short caps the score below the auto-match band so the
  // match can still be reported, but only for review.
  const componentFloor = matchingConfig.thresholds.autoMatchComponentFloor;

  if (vendor.score < componentFloor || amount.score < componentFloor) {
    hardCap = Math.min(hardCap, matchingConfig.caps.belowAutoMatchComponents);
    penalties.push(
      `${
        vendor.score < componentFloor ? "vendor" : "amount"
      } evidence is below the ${componentFloor} floor required for automatic matching`,
    );
  }

  penalty = round(penalty);
  const deterministicScore = round(Math.min(hardCap, clamp(baseScore - penalty)));
  const breakdown: ScoreBreakdown = {
    vendor: vendor.score,
    amount: amount.score,
    memo: memo.score,
    date: period.score,
    glAccount: glAccount.score,
    baseScore,
    penalty,
    hardCap,
    deterministicScore,
    finalScore: deterministicScore,
  };
  const evidence: MatchEvidence = {
    vendor: vendor.explanation,
    amount: amount.explanation,
    memo: memo.explanation,
    date: period.explanation,
    glAccount: glAccount.explanation,
    penalties,
    matchedTerms: [
      ...new Set([...memo.matchedTerms, ...glAccount.matchedTerms]),
    ].sort(),
  };

  return {
    ...seed,
    breakdown,
    evidence,
    score: deterministicScore,
    aiReview: {
      status: "not-required",
      trigger: "",
      decision: null,
      adjustment: 0,
      reasoning: "",
    },
  };
}

export function applyAIReview(
  candidate: CandidateGroup,
  review: AIReview,
): CandidateGroup {
  const finalScore = round(
    Math.min(
      candidate.breakdown.hardCap,
      clamp(candidate.breakdown.deterministicScore + review.adjustment),
    ),
  );

  return {
    ...candidate,
    score: finalScore,
    breakdown: {
      ...candidate.breakdown,
      finalScore,
    },
    aiReview: review,
  };
}

export function buildMatchReasoning(candidate: CandidateGroup): string {
  const accrualIds = candidate.accruals.map((accrual) => accrual.id).join(", ");
  const reportedScore = roundOutputScore(candidate.score);
  const sentences = [
    `${confidenceBand(candidate.score)} match to ${accrualIds} at ${reportedScore.toFixed(
      3,
    )}.`,
    `${capitalize(candidate.evidence.vendor)}.`,
    `${capitalize(candidate.evidence.amount)}.`,
    `${capitalize(candidate.evidence.memo)}.`,
    `${capitalize(candidate.evidence.date)}.`,
    `${capitalize(candidate.evidence.glAccount)}.`,
  ];

  if (candidate.evidence.penalties.length > 0) {
    sentences.push(
      `Requires review because ${candidate.evidence.penalties.join("; ")}.`,
    );
  }

  if (candidate.aiReview.status === "used") {
    sentences.push(
      `AI review ran because ${candidate.aiReview.trigger}, returned ${candidate.aiReview.decision}, and adjusted the score by ${candidate.aiReview.adjustment.toFixed(
        2,
      )}: ${candidate.aiReview.reasoning}`,
    );
  } else if (candidate.aiReview.status === "unavailable") {
    sentences.push(
      `AI review was requested because ${candidate.aiReview.trigger}, but it was unavailable, so the deterministic score stands. ${candidate.aiReview.reasoning}`,
    );
  } else {
    sentences.push(
      "AI review was not needed because the deterministic evidence was unambiguous.",
    );
  }

  return sentences.join(" ");
}

export function roundOutputScore(value: number): number {
  return round(value, 3);
}
