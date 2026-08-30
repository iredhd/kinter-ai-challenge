import { matchingConfig } from "../config.js";
import type {
  AIReview,
  AIReviewDecision,
  CandidateGroup,
} from "../types.js";
import { delay, mapWithConcurrency } from "../utils/concurrency.js";
import { applyAIReview } from "./scoring.js";

class RetryableReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableReviewError";
  }
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface ParsedAIResponse {
  decision: AIReviewDecision;
  reasoning: string;
}

function buildReviewTrigger(
  candidate: CandidateGroup,
  allCandidates: CandidateGroup[],
): string | null {
  const reasons: string[] = [];

  if (
    candidate.breakdown.deterministicScore >=
      matchingConfig.thresholds.accepted &&
    candidate.breakdown.deterministicScore <
      matchingConfig.thresholds.aiReviewUpperBound
  ) {
    reasons.push(
      `the deterministic score ${candidate.breakdown.deterministicScore.toFixed(
        3,
      )} is in the edge-case review band`,
    );
  }

  if (candidate.evidence.penalties.length > 0) {
    reasons.push(
      `the candidate has ${
        candidate.evidence.penalties.length === 1
          ? "an accounting caution"
          : "accounting cautions"
      }`,
    );
  }

  const candidateTransactionIds = new Set(
    candidate.transactions.map((transaction) => transaction.id),
  );
  const hasCloseCompetitor = allCandidates.some((other) => {
    if (
      other.id === candidate.id ||
      other.score < matchingConfig.thresholds.accepted
    ) {
      return false;
    }

    const sharesTransaction = other.transactions.some((transaction) =>
      candidateTransactionIds.has(transaction.id),
    );
    const scoreGap = Math.abs(other.score - candidate.score);

    return (
      sharesTransaction &&
      scoreGap <= matchingConfig.thresholds.closeCandidateGap
    );
  });

  if (hasCloseCompetitor) {
    reasons.push("another supported candidate has a similar score");
  }

  return reasons.length > 0 ? reasons.join(" and ") : null;
}

function adjustmentForDecision(decision: AIReviewDecision): number {
  if (decision === "support") {
    return matchingConfig.openRouter.maximumAdjustment;
  }

  if (decision === "reject") {
    return -matchingConfig.openRouter.maximumAdjustment;
  }

  return 0;
}

function parseAIResponse(response: OpenRouterResponse): ParsedAIResponse {
  const rawContent = response.choices?.[0]?.message?.content;

  if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
    throw new TypeError("OpenRouter returned no review content");
  }

  const cleanedContent = rawContent
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(cleanedContent);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("decision" in parsed) ||
    !("reasoning" in parsed)
  ) {
    throw new TypeError("OpenRouter returned an invalid review object");
  }

  const decision = parsed.decision;
  const reasoning = parsed.reasoning;

  if (
    decision !== "support" &&
    decision !== "neutral" &&
    decision !== "reject"
  ) {
    throw new TypeError("OpenRouter returned an invalid review decision");
  }

  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    throw new TypeError("OpenRouter returned no review reasoning");
  }

  return {
    decision,
    reasoning: reasoning.trim(),
  };
}

async function requestAIReview(
  candidate: CandidateGroup,
  trigger: string,
  apiKey: string,
): Promise<ParsedAIResponse> {
  const response = await fetch(matchingConfig.openRouter.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "Kinter Accrual Matching",
    },
    signal: AbortSignal.timeout(matchingConfig.openRouter.timeoutMs),
    body: JSON.stringify({
      model: matchingConfig.openRouter.model,
      temperature: 0,
      // The budget must cover the thinking tokens as well as the JSON answer;
      // too small a ceiling truncates the response and silently loses the review.
      max_tokens: matchingConfig.openRouter.maxOutputTokens,
      reasoning: {
        effort: matchingConfig.openRouter.reasoningEffort,
      },
      provider: {
        require_parameters: true,
      },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "accrual_match_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                enum: ["support", "neutral", "reject"],
                description:
                  "Whether the supplied evidence supports this candidate match.",
              },
              reasoning: {
                type: "string",
                description:
                  "A concise accounting explanation grounded only in the supplied records; partial bundles must state that allocation remains unverified.",
              },
            },
            required: ["decision", "reasoning"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You are reviewing an accrual-accounting match already scored by deterministic rules. Review only the supplied candidate. Do not invent records, allocations, vendor aliases, or missing accruals. Amount residuals and explicit period conflicts cannot be overridden. A transaction-to-accrual amount ratio may support a partial relationship, but it never proves an equal allocation; explicitly state that any partial allocation remains unverified. Return support, neutral, or reject with a concise evidence-based explanation.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              review_trigger: trigger,
              transactions: candidate.transactions,
              accruals: candidate.accruals,
              candidate_kind: candidate.kind,
              score_breakdown: candidate.breakdown,
              evidence: candidate.evidence,
              constraint:
                "This review changes confidence by at most 0.05 and cannot override the deterministic hard cap or treat an arithmetic split as a confirmed allocation.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const safeBody = errorBody.slice(0, 300);
    const message = `OpenRouter review failed with ${response.status}: ${safeBody}`;

    if (isRetryableStatus(response.status)) {
      throw new RetryableReviewError(message);
    }

    throw new Error(message);
  }

  return parseAIResponse(
    (await response.json()) as OpenRouterResponse,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableReviewError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  // Aborted requests and transport-level failures are worth another attempt;
  // a malformed response body is not.
  const causeCode =
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause
      ? String((error.cause as { code: unknown }).code)
      : "";

  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    /fetch failed|network|socket hang up/i.test(error.message) ||
    /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(causeCode)
  );
}

async function requestAIReviewWithRetry(
  candidate: CandidateGroup,
  trigger: string,
  apiKey: string,
): Promise<ParsedAIResponse> {
  const { maxRetries, retryBaseDelayMs } = matchingConfig.openRouter;
  let lastError: unknown = new Error("OpenRouter review was never attempted");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestAIReview(candidate, trigger, apiKey);
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !isRetryableError(error)) {
        break;
      }

      await delay(retryBaseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}

function unavailableReview(trigger: string, error: unknown): AIReview {
  const message =
    error instanceof Error ? error.message : "Unknown OpenRouter error";

  return {
    status: "unavailable",
    trigger,
    decision: null,
    adjustment: 0,
    reasoning: message,
  };
}

export async function reviewSelectedCandidates(
  selectedCandidates: CandidateGroup[],
  allCandidates: CandidateGroup[],
): Promise<CandidateGroup[]> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  return mapWithConcurrency(
    selectedCandidates,
    matchingConfig.openRouter.concurrency,
    async (candidate) => {
      const trigger = buildReviewTrigger(candidate, allCandidates);

      if (trigger === null) {
        return candidate;
      }

      if (apiKey === undefined || apiKey.length === 0) {
        return applyAIReview(
          candidate,
          unavailableReview(
            trigger,
            new Error("OPENROUTER_API_KEY is not configured"),
          ),
        );
      }

      try {
        const response = await requestAIReviewWithRetry(
          candidate,
          trigger,
          apiKey,
        );

        return applyAIReview(candidate, {
          status: "used",
          trigger,
          decision: response.decision,
          adjustment: adjustmentForDecision(response.decision),
          reasoning: response.reasoning,
        });
      } catch (error) {
        return applyAIReview(candidate, unavailableReview(trigger, error));
      }
    },
  );
}
