import { matchingConfig } from "../config.js";
import type {
  AccrualEntry,
  PeriodExtraction,
  ServicePeriod,
  Transaction,
} from "../types.js";
import { round } from "../utils/number.js";

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const monthAliases: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const monthPattern =
  /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/gi;
const monthRangePattern =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(?:\/|&|\band\b|-)\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const aggregationLanguagePattern =
  /\b(combined|consolidated|multi(?:ple)?[- ]month|quarterly|spanning|bundle[ds]?)\b/i;
const contextualPrefixPattern = /\b(based on|since|according to|per)\s*$/i;
const contextualSuffixPattern =
  /^\s*(?:\d{1,2}\s+)?(?:actual|actuals|email|report|reference)\b/i;

export interface PeriodScoreResult {
  score: number;
  periodConflict: boolean;
  explanation: string;
}

function parseReferenceDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid reference date "${value}"`);
  }

  return parsed;
}

function inferYear(month: number, referenceDate: Date): number {
  const referenceMonth = referenceDate.getUTCMonth() + 1;
  const referenceYear = referenceDate.getUTCFullYear();

  if (referenceMonth <= 2 && month >= 10) {
    return referenceYear - 1;
  }

  if (referenceMonth >= 11 && month <= 2) {
    return referenceYear + 1;
  }

  return referenceYear;
}

function createPeriod(year: number, month: number): ServicePeriod {
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    year,
    month,
    label: `${monthNames[month - 1] ?? "Unknown"} ${year}`,
  };
}

function addUnique(collection: ServicePeriod[], period: ServicePeriod): void {
  if (!collection.some((existing) => existing.key === period.key)) {
    collection.push(period);
  }
}

function isContextualReference(
  text: string,
  matchIndex: number,
  matchedValue: string,
): boolean {
  const before = text.slice(Math.max(0, matchIndex - 32), matchIndex);
  const after = text.slice(matchIndex + matchedValue.length, matchIndex + 40);

  return (
    contextualPrefixPattern.test(before) ||
    (/\b(based on|per)\b/i.test(before) && contextualSuffixPattern.test(after))
  );
}

function hasExplicitMultiPeriodLanguage(text: string): boolean {
  // A bare quarter reference is not aggregation evidence on its own: a quarterly
  // true-up is normally a single settlement, not a bundle of separate invoices.
  const quarterWithCorroboration =
    /\bq[1-4]\b/i.test(text) &&
    (aggregationLanguagePattern.test(text) || monthRangePattern.test(text));

  return (
    quarterWithCorroboration ||
    monthRangePattern.test(text) ||
    aggregationLanguagePattern.test(text)
  );
}

export function extractPeriods(
  text: string,
  referenceDateValue: string,
): PeriodExtraction {
  const referenceDate = parseReferenceDate(referenceDateValue);
  const primary: ServicePeriod[] = [];
  const contextual: ServicePeriod[] = [];
  let explicitMatchCount = 0;

  for (const match of text.matchAll(monthPattern)) {
    const value = match[0].toLowerCase();
    const month = monthAliases[value];

    if (month === undefined || match.index === undefined) {
      continue;
    }

    explicitMatchCount += 1;
    const period = createPeriod(inferYear(month, referenceDate), month);

    if (isContextualReference(text, match.index, match[0])) {
      addUnique(contextual, period);
    } else {
      addUnique(primary, period);
    }
  }

  const numericPeriodPattern = /\b(0?[1-9]|1[0-2])\/(\d{2}|\d{4})\b/g;

  for (const match of text.matchAll(numericPeriodPattern)) {
    const month = Number(match[1]);
    const rawYear = Number(match[2]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;

    explicitMatchCount += 1;
    addUnique(primary, createPeriod(year, month));
  }

  const quarterPattern = /\bq([1-4])(?:\s+(\d{4}))?\b/gi;

  for (const match of text.matchAll(quarterPattern)) {
    const quarter = Number(match[1]);
    const year = match[2] ? Number(match[2]) : referenceDate.getUTCFullYear();
    const firstMonth = (quarter - 1) * 3 + 1;

    explicitMatchCount += 1;

    for (let monthOffset = 0; monthOffset < 3; monthOffset += 1) {
      addUnique(primary, createPeriod(year, firstMonth + monthOffset));
    }
  }

  if (primary.length === 0) {
    addUnique(
      primary,
      createPeriod(
        referenceDate.getUTCFullYear(),
        referenceDate.getUTCMonth() + 1,
      ),
    );
  }

  return {
    primary,
    contextual,
    hasExplicitPeriod: explicitMatchCount > 0,
    explicitMultiPeriod: hasExplicitMultiPeriodLanguage(text),
  };
}

function uniquePeriods(
  extractions: PeriodExtraction[],
  field: "primary" | "contextual",
): ServicePeriod[] {
  const result: ServicePeriod[] = [];

  for (const extraction of extractions) {
    for (const period of extraction[field]) {
      addUnique(result, period);
    }
  }

  return result;
}

function monthDistance(left: ServicePeriod, right: ServicePeriod): number {
  return Math.abs((left.year - right.year) * 12 + left.month - right.month);
}

function calculatePostingScore(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): number {
  const { postingWindowDays, postingScores } = matchingConfig.date;
  const scores = transactions.map((transaction) => {
    const transactionDate = parseReferenceDate(transaction.date).getTime();
    let best: number = postingScores.stale;

    for (const accrual of accruals) {
      const accrualDate = parseReferenceDate(accrual.accrual_date).getTime();
      const days = (transactionDate - accrualDate) / 86_400_000;

      if (days >= 0 && days <= postingWindowDays.onTime) {
        best = Math.max(best, postingScores.onTime);
      } else if (
        (days > postingWindowDays.onTime && days <= postingWindowDays.late) ||
        (days < 0 && days >= -postingWindowDays.earlyToleranceDays)
      ) {
        best = Math.max(best, postingScores.late);
      }
    }

    return best;
  });

  return scores.length === 0
    ? 0
    : scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export function compareCandidatePeriods(
  accruals: AccrualEntry[],
  transactions: Transaction[],
): PeriodScoreResult {
  const { tiers, serviceWeight, postingWeight } = matchingConfig.date;
  const accrualExtractions = accruals.map((accrual) =>
    extractPeriods(accrual.memo, accrual.accrual_date),
  );
  const transactionExtractions = transactions.map((transaction) =>
    extractPeriods(transaction.description, transaction.date),
  );
  const accrualPeriods = uniquePeriods(accrualExtractions, "primary");
  const transactionPeriods = uniquePeriods(transactionExtractions, "primary");
  const accrualKeys = new Set(accrualPeriods.map((period) => period.key));
  const transactionKeys = new Set(
    transactionPeriods.map((period) => period.key),
  );
  const overlap = [...accrualKeys].filter((key) => transactionKeys.has(key));
  const samePeriods =
    overlap.length === accrualKeys.size &&
    overlap.length === transactionKeys.size;
  const accrualExplicit = accrualExtractions.some(
    (value) => value.hasExplicitPeriod,
  );
  const transactionExplicit = transactionExtractions.some(
    (value) => value.hasExplicitPeriod,
  );
  const bothExplicit = accrualExplicit && transactionExplicit;
  const neitherExplicit = !accrualExplicit && !transactionExplicit;
  let serviceScore: number = tiers.conflict;

  if (samePeriods) {
    serviceScore = tiers.exact;
  } else if (overlap.length > 0) {
    serviceScore = tiers.partial;
  } else if (neitherExplicit) {
    // Both sides fell back to their record dates, so there is no stated period
    // to agree or disagree with. Stay neutral instead of implying a conflict.
    serviceScore = tiers.unavailable;
  } else {
    const nearestDistance = Math.min(
      ...accrualPeriods.flatMap((accrualPeriod) =>
        transactionPeriods.map((transactionPeriod) =>
          monthDistance(accrualPeriod, transactionPeriod),
        ),
      ),
    );

    serviceScore =
      !bothExplicit && nearestDistance <= 1 ? tiers.adjacent : tiers.conflict;
  }

  const periodConflict = overlap.length === 0 && bothExplicit;
  const postingScore = calculatePostingScore(accruals, transactions);
  const accrualLabels = accrualPeriods.map((period) => period.label).join(", ");
  const transactionLabels = transactionPeriods
    .map((period) => period.label)
    .join(", ");
  // A month that also appears as a stated service period somewhere in the
  // candidate is not a diverted reference, so reporting it would contradict the
  // overlap just described.
  const contextualLabels = uniquePeriods(
    [...accrualExtractions, ...transactionExtractions],
    "contextual",
  )
    .filter(
      (period) =>
        !accrualKeys.has(period.key) && !transactionKeys.has(period.key),
    )
    .map((period) => period.label)
    .join(", ");
  const comparison =
    overlap.length > 0
      ? `service periods overlap (${transactionLabels} versus ${accrualLabels})`
      : neitherExplicit
        ? `neither record states a service period, so posting dates were used (${transactionLabels} versus ${accrualLabels})`
        : `service periods differ (${transactionLabels} versus ${accrualLabels})`;
  const explanation =
    contextualLabels.length > 0
      ? `${comparison}; ${contextualLabels} was read as a reference basis rather than a service period`
      : comparison;

  return {
    score: round(serviceWeight * serviceScore + postingWeight * postingScore),
    periodConflict,
    explanation,
  };
}

export function periodsOverlap(
  left: PeriodExtraction,
  right: PeriodExtraction,
): boolean {
  const rightKeys = new Set(right.primary.map((period) => period.key));

  return left.primary.some((period) => rightKeys.has(period.key));
}
