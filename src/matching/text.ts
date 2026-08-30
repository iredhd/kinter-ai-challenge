import { matchingConfig } from "../config.js";
import { round } from "../utils/number.js";

const abbreviationAliases = matchingConfig.abbreviationAliases as Record<
  string,
  string
>;
const pluralAliases: Record<string, string> = {
  brokers: "broker",
  facilities: "facilities",
  hours: "hour",
  seats: "seat",
  services: "service",
  subscriptions: "subscription",
};
const legalSuffixes = new Set<string>(matchingConfig.legalSuffixes);
const stopWords = new Set<string>(matchingConfig.stopWords);
const periodWords = new Set([
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
  "q1",
  "q2",
  "q3",
  "q4",
]);
const qualifierTerms = new Set<string>([
  "adjustment",
  "combined",
  "consulting",
  "freight",
  "hour",
  "insurance",
  "liability",
  "management",
  "overage",
  "premium",
  "prorated",
  "property",
  "retainer",
  "service",
  "subscription",
  "usage",
  ...matchingConfig.lineItemTerms,
  ...Object.values(matchingConfig.glGlossary).flat(),
]);

export type VendorMatchBasis = "name" | "acronym" | "narrative";

export interface VendorSimilarityResult {
  score: number;
  matchedVia: VendorMatchBasis;
}

export interface NarrativeSimilarityResult {
  score: number;
  matchedTerms: string[];
}

export function normalizeText(value: string): string {
  const phraseNormalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/\btrue[\s-]?up\b/g, " adjustment ")
    .replace(/\bactuals?\b/g, " actual ")
    .replace(/\best(?:imate|imated)?\.?\b/g, " estimate ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return phraseNormalized
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => abbreviationAliases[token] ?? pluralAliases[token] ?? token)
    .join(" ");
}

function normalizeVendor(value: string): string {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 0 && !legalSuffixes.has(token))
    .join(" ");
}

function vendorAcronym(value: string): string {
  return normalizeVendor(value)
    .split(" ")
    .filter((token) => token !== "and" && token.length > 0)
    .map((token) => token[0] ?? "")
    .join("");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const deletion = (previous[rightIndex] ?? 0) + 1;
      const insertion = (current[rightIndex - 1] ?? 0) + 1;
      const substitution = (previous[rightIndex - 1] ?? 0) + substitutionCost;

      current[rightIndex] = Math.min(deletion, insertion, substitution);
    }

    previous = current;
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

function normalizedLevenshtein(left: string, right: string): number {
  const maximumLength = Math.max(left.length, right.length);

  if (maximumLength === 0) {
    return 1;
  }

  return round(1 - levenshteinDistance(left, right) / maximumLength);
}

function bestWindowSimilarity(target: string, narrative: string): number {
  const targetTokens = target.split(" ").filter(Boolean);
  const narrativeTokens = narrative.split(" ").filter(Boolean);

  if (targetTokens.length === 0 || narrativeTokens.length === 0) {
    return 0;
  }

  if (narrative.includes(target)) {
    return 1;
  }

  let best = normalizedLevenshtein(target, narrative);
  const minimumSize = Math.max(1, targetTokens.length - 1);
  const maximumSize = Math.min(narrativeTokens.length, targetTokens.length + 1);

  for (let size = minimumSize; size <= maximumSize; size += 1) {
    for (let start = 0; start + size <= narrativeTokens.length; start += 1) {
      const window = narrativeTokens.slice(start, start + size).join(" ");
      best = Math.max(best, normalizedLevenshtein(target, window));
    }
  }

  return round(best);
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);

  if (union.size === 0) {
    return 1;
  }

  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;

  return round(intersection / union.size);
}

export function compareVendors(
  accrualVendor: string,
  accrualMemo: string,
  transactionVendor: string,
  transactionDescription: string,
): VendorSimilarityResult {
  const normalizedAccrual = normalizeVendor(accrualVendor);
  const normalizedTransaction = normalizeVendor(transactionVendor);
  const normalizedMemo = normalizeText(accrualMemo);
  const normalizedDescription = normalizeText(transactionDescription);
  const fieldSimilarity = normalizedLevenshtein(
    normalizedAccrual,
    normalizedTransaction,
  );
  const narrativeSimilarity = Math.max(
    bestWindowSimilarity(normalizedAccrual, normalizedDescription),
    bestWindowSimilarity(normalizedTransaction, normalizedMemo),
  );
  const tokenSimilarity = tokenJaccard(normalizedAccrual, normalizedTransaction);
  const accrualAcronym = vendorAcronym(accrualVendor);
  const transactionAcronym = vendorAcronym(transactionVendor);
  const transactionContext =
    `${normalizedTransaction} ${normalizedDescription}`.split(" ");
  const accrualContext = `${normalizedAccrual} ${normalizedMemo}`.split(" ");
  const acronymMatch =
    (accrualAcronym.length > 1 && transactionContext.includes(accrualAcronym)) ||
    (transactionAcronym.length > 1 &&
      accrualContext.includes(transactionAcronym));
  const lexicalSimilarity = Math.max(fieldSimilarity, narrativeSimilarity);
  const supportingSimilarity = Math.max(tokenSimilarity, acronymMatch ? 1 : 0);
  const score = round(
    matchingConfig.vendor.lexicalWeight * lexicalSimilarity +
      matchingConfig.vendor.supportingWeight * supportingSimilarity,
  );

  // Report the signal that actually carried the match. When the two names
  // compare directly there is nothing to explain; only a weaker direct
  // comparison means an abbreviation or narrative text bridged the records.
  let matchedVia: VendorMatchBasis = "name";

  if (fieldSimilarity < lexicalSimilarity) {
    matchedVia = acronymMatch ? "acronym" : "narrative";
  }

  return {
    score,
    matchedVia,
  };
}

function comparableTokens(
  value: string,
  excludedVendorValues: string[],
): Set<string> {
  const excludedTokens = new Set(
    excludedVendorValues.flatMap((vendor) =>
      normalizeVendor(vendor).split(" ").filter(Boolean),
    ),
  );

  return new Set(
    normalizeText(value)
      .split(" ")
      .filter(
        (token) =>
          token.length > 1 &&
          !stopWords.has(token) &&
          !periodWords.has(token) &&
          !excludedTokens.has(token) &&
          !/^\d+$/.test(token) &&
          !/^[a-z]+\d+$/.test(token),
      ),
  );
}

export function compareNarratives(
  accrualMemo: string,
  transactionDescription: string,
  accrualVendor: string,
  transactionVendor: string,
): NarrativeSimilarityResult {
  const { conceptFloor, conceptWeight, qualifierWeight } = matchingConfig.memo;
  const memoTokens = comparableTokens(accrualMemo, [
    accrualVendor,
    transactionVendor,
  ]);
  const descriptionTokens = comparableTokens(transactionDescription, [
    accrualVendor,
    transactionVendor,
  ]);
  const matchedTerms = [...memoTokens]
    .filter((token) => descriptionTokens.has(token))
    .sort();
  const smallerSetSize = Math.min(memoTokens.size, descriptionTokens.size);
  // Containment against the smaller set, so extra memo wording an invoice would
  // never repeat cannot dilute an otherwise exact narrative agreement.
  const containment =
    smallerSetSize === 0 ? 0 : matchedTerms.length / smallerSetSize;
  const conceptScore =
    matchedTerms.length === 0
      ? conceptFloor
      : conceptFloor + (1 - conceptFloor) * containment;
  const memoQualifiers = new Set(
    [...memoTokens].filter((token) => qualifierTerms.has(token)),
  );
  const descriptionQualifiers = new Set(
    [...descriptionTokens].filter((token) => qualifierTerms.has(token)),
  );
  const sharedQualifiers = [...memoQualifiers].filter((token) =>
    descriptionQualifiers.has(token),
  );

  let qualifierScore: number = matchingConfig.memo.qualifierNeutral;

  if (sharedQualifiers.length > 0) {
    qualifierScore = matchingConfig.memo.qualifierAgreement;
  } else if (memoQualifiers.size > 0 && descriptionQualifiers.size > 0) {
    qualifierScore = matchingConfig.memo.qualifierConflict;
  }

  return {
    score: round(conceptWeight * conceptScore + qualifierWeight * qualifierScore),
    matchedTerms,
  };
}

export function hasAggregationLanguage(value: string): boolean {
  const tokens = new Set(normalizeText(value).split(" "));

  return matchingConfig.aggregationTerms.some((term) => tokens.has(term));
}

export function getDistinctiveTokens(value: string, vendor: string): string[] {
  return [...comparableTokens(value, [vendor])].filter(
    (token) => qualifierTerms.has(token) || token.length >= 5,
  );
}
