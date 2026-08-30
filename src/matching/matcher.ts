import { matchingConfig } from "../config.js";
import type {
  AccrualEntry,
  CandidateGroup,
  CandidateKind,
  CandidateSeed,
  MatchResult,
  PeriodExtraction,
  Transaction,
} from "../types.js";
import { reviewSelectedCandidates } from "./ai-review.js";
import { extractPeriods, periodsOverlap } from "./periods.js";
import {
  buildMatchReasoning,
  roundOutputScore,
  scoreCandidate,
} from "./scoring.js";
import {
  compareVendors,
  getDistinctiveTokens,
  hasAggregationLanguage,
  normalizeText,
} from "./text.js";

interface PairContext {
  vendorScore: number;
  periodsOverlap: boolean;
}

interface MatchingContext {
  accrualPeriods: Map<string, PeriodExtraction>;
  transactionPeriods: Map<string, PeriodExtraction>;
  pairs: Map<string, PairContext>;
}

function pairKey(transactionId: string, accrualId: string): string {
  return `${transactionId}::${accrualId}`;
}

function sumAmounts(
  records: Array<AccrualEntry | Transaction>,
): number {
  return records.reduce((sum, record) => sum + record.amount, 0);
}

function candidateId(
  kind: CandidateKind,
  transactions: Transaction[],
  accruals: AccrualEntry[],
): string {
  const transactionIds = transactions
    .map((transaction) => transaction.id)
    .sort()
    .join("+");
  const accrualIds = accruals
    .map((accrual) => accrual.id)
    .sort()
    .join("+");

  return `${kind}:${transactionIds}:${accrualIds}`;
}

function createSeed(
  kind: CandidateKind,
  transactions: Transaction[],
  accruals: AccrualEntry[],
  options: {
    amountExpected?: number;
    periodScale?: number;
    amountActual?: number;
    groupingReliability?: number;
    groupingReason: string;
    unresolvedResidual?: number;
  },
): CandidateSeed {
  const accrualTotal = sumAmounts(accruals);

  return {
    id: candidateId(kind, transactions, accruals),
    transactions,
    accruals,
    kind,
    amountExpected: options.amountExpected ?? accrualTotal,
    amountExpectedRaw: accrualTotal,
    periodScale: options.periodScale ?? 1,
    amountActual: options.amountActual ?? sumAmounts(transactions),
    groupingReliability:
      options.groupingReliability ??
      matchingConfig.amount.directReliability,
    groupingReason: options.groupingReason,
    unresolvedResidual: options.unresolvedResidual ?? 0,
  };
}

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];

  function visit(start: number, selected: T[]): void {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }

    const remainingNeeded = size - selected.length;

    for (
      let index = start;
      index <= items.length - remainingNeeded;
      index += 1
    ) {
      const item = items[index];

      if (item !== undefined) {
        selected.push(item);
        visit(index + 1, selected);
        selected.pop();
      }
    }
  }

  visit(0, []);

  return result;
}

function buildMatchingContext(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): MatchingContext {
  const accrualPeriods = new Map(
    accruals.map((accrual) => [
      accrual.id,
      extractPeriods(accrual.memo, accrual.accrual_date),
    ]),
  );
  const transactionPeriods = new Map(
    transactions.map((transaction) => [
      transaction.id,
      extractPeriods(transaction.description, transaction.date),
    ]),
  );
  const pairs = new Map<string, PairContext>();

  for (const transaction of transactions) {
    const transactionPeriod = transactionPeriods.get(transaction.id);

    if (transactionPeriod === undefined) {
      continue;
    }

    for (const accrual of accruals) {
      const accrualPeriod = accrualPeriods.get(accrual.id);

      if (accrualPeriod === undefined) {
        continue;
      }

      const vendor = compareVendors(
        accrual.vendor,
        accrual.memo,
        transaction.vendor,
        transaction.description,
      );

      pairs.set(pairKey(transaction.id, accrual.id), {
        vendorScore: vendor.score,
        periodsOverlap: periodsOverlap(
          transactionPeriod,
          accrualPeriod,
        ),
      });
    }
  }

  return {
    accrualPeriods,
    transactionPeriods,
    pairs,
  };
}

function generateOneToOneSeeds(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): CandidateSeed[] {
  return transactions.flatMap((transaction) =>
    accruals.map((accrual) =>
      createSeed("one-to-one", [transaction], [accrual], {
        groupingReason: "direct one-to-one amount comparison",
      }),
    ),
  );
}

function supportsEveryAccrualNarrative(
  transaction: Transaction,
  accruals: AccrualEntry[],
): boolean {
  const normalizedDescription = new Set(
    normalizeText(transaction.description).split(" "),
  );

  return accruals.every((accrual) =>
    getDistinctiveTokens(accrual.memo, accrual.vendor).some((token) =>
      normalizedDescription.has(token),
    ),
  );
}

function generateOneTransactionToManyAccrualSeeds(
  accruals: AccrualEntry[],
  transactions: Transaction[],
  context: MatchingContext,
): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];

  for (const transaction of transactions) {
    if (!hasAggregationLanguage(transaction.description)) {
      continue;
    }

    const eligibleAccruals = accruals
      .filter((accrual) => {
        const pair = context.pairs.get(
          pairKey(transaction.id, accrual.id),
        );

        return (
          pair !== undefined &&
          pair.vendorScore >= matchingConfig.thresholds.groupVendorFloor &&
          pair.periodsOverlap
        );
      })
      .sort((left, right) => {
        const rightScore =
          context.pairs.get(pairKey(transaction.id, right.id))
            ?.vendorScore ?? 0;
        const leftScore =
          context.pairs.get(pairKey(transaction.id, left.id))
            ?.vendorScore ?? 0;

        return rightScore - leftScore;
      })
      .slice(0, matchingConfig.maxGroupCandidatePool);
    const largestGroup = Math.min(
      matchingConfig.maxGroupSize,
      eligibleAccruals.length,
    );

    for (let size = 2; size <= largestGroup; size += 1) {
      for (const group of combinations(eligibleAccruals, size)) {
        if (!supportsEveryAccrualNarrative(transaction, group)) {
          continue;
        }

        seeds.push(
          createSeed(
            "one-transaction-to-many-accruals",
            [transaction],
            group,
            {
              groupingReliability:
                matchingConfig.amount.explicitGroupReliability,
              groupingReason:
                "the transaction explicitly describes the grouped accrual components",
            },
          ),
        );
      }
    }
  }

  return seeds;
}

function generateManyTransactionsToOneAccrualSeeds(
  accruals: AccrualEntry[],
  transactions: Transaction[],
  context: MatchingContext,
): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];

  for (const accrual of accruals) {
    const accrualPeriod = context.accrualPeriods.get(accrual.id);

    if (
      accrualPeriod === undefined ||
      !accrualPeriod.explicitMultiPeriod
    ) {
      continue;
    }

    const eligibleTransactions = transactions
      .filter((transaction) => {
        const pair = context.pairs.get(
          pairKey(transaction.id, accrual.id),
        );

        return (
          pair !== undefined &&
          pair.vendorScore >= matchingConfig.thresholds.groupVendorFloor &&
          pair.periodsOverlap
        );
      })
      .sort((left, right) => {
        const rightScore =
          context.pairs.get(pairKey(right.id, accrual.id))
            ?.vendorScore ?? 0;
        const leftScore =
          context.pairs.get(pairKey(left.id, accrual.id))
            ?.vendorScore ?? 0;

        return rightScore - leftScore;
      })
      .slice(0, matchingConfig.maxGroupCandidatePool);
    const largestGroup = Math.min(
      matchingConfig.maxGroupSize,
      eligibleTransactions.length,
    );

    for (let size = 2; size <= largestGroup; size += 1) {
      for (const group of combinations(eligibleTransactions, size)) {
        seeds.push(
          createSeed(
            "many-transactions-to-one-accrual",
            group,
            [accrual],
            {
              groupingReliability:
                matchingConfig.amount.explicitGroupReliability,
              groupingReason:
                "the accrual explicitly covers multiple service periods",
            },
          ),
        );
      }
    }
  }

  return seeds;
}

function generatePartialMultiPeriodSeeds(
  accruals: AccrualEntry[],
  transactions: Transaction[],
  context: MatchingContext,
): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];

  for (const transaction of transactions) {
    const transactionPeriod = context.transactionPeriods.get(
      transaction.id,
    );

    if (
      transactionPeriod === undefined ||
      !transactionPeriod.explicitMultiPeriod ||
      transactionPeriod.primary.length < 2
    ) {
      continue;
    }

    const transactionPeriodKeys = new Set(
      transactionPeriod.primary.map((period) => period.key),
    );

    for (const accrual of accruals) {
      const pair = context.pairs.get(
        pairKey(transaction.id, accrual.id),
      );
      const accrualPeriod = context.accrualPeriods.get(accrual.id);

      if (
        pair === undefined ||
        pair.vendorScore < matchingConfig.thresholds.partialVendorFloor ||
        !pair.periodsOverlap ||
        accrualPeriod === undefined
      ) {
        continue;
      }

      const coveredPeriodCount = accrualPeriod.primary.filter((period) =>
        transactionPeriodKeys.has(period.key),
      ).length;

      if (
        coveredPeriodCount === 0 ||
        coveredPeriodCount >= transactionPeriod.primary.length
      ) {
        continue;
      }

      const scale =
        transactionPeriod.primary.length / coveredPeriodCount;
      const scaledExpected = accrual.amount * scale;
      const rawAmountScore =
        scaledExpected === 0 || transaction.amount === 0
          ? 0
          : Math.exp(
              -matchingConfig.amount.decay *
                Math.abs(
                  Math.log(
                    Math.abs(transaction.amount) /
                      Math.abs(scaledExpected),
                  ),
                ),
            );

      if (rawAmountScore < matchingConfig.thresholds.partialAmountFloor) {
        continue;
      }

      const coveredShare =
        coveredPeriodCount / transactionPeriod.primary.length;

      seeds.push(
        createSeed(
          "partial-multi-period",
          [transaction],
          [accrual],
          {
            amountExpected: scaledExpected,
            periodScale: scale,
            groupingReliability:
              matchingConfig.amount.partialBundleReliability,
            groupingReason: `the invoice explicitly spans ${
              transactionPeriod.primary.length
            } periods while the accrual supports ${coveredPeriodCount}`,
            unresolvedResidual:
              Math.abs(transaction.amount) * (1 - coveredShare),
          },
        ),
      );
    }
  }

  return seeds;
}

export function generateCandidates(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): CandidateGroup[] {
  const context = buildMatchingContext(accruals, transactions);

  const seeds = [
    ...generateOneToOneSeeds(accruals, transactions),
    ...generateOneTransactionToManyAccrualSeeds(
      accruals,
      transactions,
      context,
    ),
    ...generateManyTransactionsToOneAccrualSeeds(
      accruals,
      transactions,
      context,
    ),
    ...generatePartialMultiPeriodSeeds(
      accruals,
      transactions,
      context,
    ),
  ];
  
  const uniqueSeeds = new Map(seeds.map((seed) => [seed.id, seed]));
  
  return [...uniqueSeeds.values()]
    .map(scoreCandidate)
    .filter(
      (candidate) =>
        candidate.score >= matchingConfig.thresholds.candidateFloor,
    );
}

export function selectCandidateGroups(
  candidates: CandidateGroup[],
): CandidateGroup[] {
  const sorted = [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const rightCoverage =
      right.transactions.length + right.accruals.length;
    const leftCoverage =
      left.transactions.length + left.accruals.length;

    if (rightCoverage !== leftCoverage) {
      return rightCoverage - leftCoverage;
    }

    return left.id.localeCompare(right.id);
  });
  const usedTransactions = new Set<string>();
  const usedAccruals = new Set<string>();
  const selected: CandidateGroup[] = [];

  for (const candidate of sorted) {
    if (candidate.score < matchingConfig.thresholds.accepted) {
      continue;
    }

    if (
      candidate.transactions.some((transaction) =>
        usedTransactions.has(transaction.id),
      ) ||
      candidate.accruals.some((accrual) =>
        usedAccruals.has(accrual.id),
      )
    ) {
      continue;
    }

    selected.push(candidate);
    candidate.transactions.forEach((transaction) =>
      usedTransactions.add(transaction.id),
    );
    candidate.accruals.forEach((accrual) =>
      usedAccruals.add(accrual.id),
    );
  }

  return selected;
}

function validateUniqueTransactionIds(transactions: Transaction[]): void {
  const seen = new Set<string>();

  for (const transaction of transactions) {
    if (seen.has(transaction.id)) {
      throw new TypeError(
        `Duplicate transaction id "${transaction.id}" prevents one-result-per-transaction output`,
      );
    }

    seen.add(transaction.id);
  }
}

function validateResultCardinality(
  transactions: Transaction[],
  results: MatchResult[],
): void {
  const inputIds = transactions.map((transaction) => transaction.id);
  const outputIds = results.map((result) => result.transaction_id);
  const uniqueOutputIds = new Set(outputIds);

  if (
    results.length !== transactions.length ||
    uniqueOutputIds.size !== results.length ||
    inputIds.some((id, index) => outputIds[index] !== id)
  ) {
    throw new Error(
      "Matching output must contain exactly one ordered result per input transaction",
    );
  }
}

export function createTransactionResults(
  transactions: Transaction[],
  selectedCandidates: CandidateGroup[],
): MatchResult[] {
  const selectedByTransaction = new Map<string, CandidateGroup>();

  for (const candidate of selectedCandidates) {
    for (const transaction of candidate.transactions) {
      if (selectedByTransaction.has(transaction.id)) {
        throw new Error(
          `Transaction "${transaction.id}" was selected more than once`,
        );
      }

      selectedByTransaction.set(transaction.id, candidate);
    }
  }

  const results = transactions.map((transaction): MatchResult => {
    const candidate = selectedByTransaction.get(transaction.id);

    if (candidate === undefined) {
      return {
        transaction_id: transaction.id,
        matched_accrual_ids: [],
        score: 0,
        reasoning:
          "No accrual candidate met the minimum deterministic confidence and conflict rules. AI review was not used because no candidate qualified for edge-case review.",
      };
    }

    return {
      transaction_id: transaction.id,
      matched_accrual_ids: candidate.accruals.map(
        (accrual) => accrual.id,
      ),
      score: roundOutputScore(candidate.score),
      reasoning: buildMatchReasoning(candidate),
    };
  });

  validateResultCardinality(transactions, results);

  return results;
}

export async function matchAccrualsToTransactions(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): Promise<MatchResult[]> {
  validateUniqueTransactionIds(transactions);
  const candidates = generateCandidates(accruals, transactions);
  const selected = selectCandidateGroups(candidates);
  const reviewed = await reviewSelectedCandidates(selected, candidates);
  const accepted = reviewed.filter(
    (candidate) =>
      candidate.score >= matchingConfig.thresholds.accepted,
  );

  return createTransactionResults(transactions, accepted);
}
