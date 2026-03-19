// ============================================================
// Texting Theory Bot — Shared API Types & Constants
// ============================================================

// --- Tuning constants (single source of truth) ---

export const MIN_VOTES_FOR_BADGE_CONSENSUS = 10;
export const MIN_VOTES_FOR_POST_FLAIR = 1;
export const MIN_VOTES_TO_SHOW_ELO_IN_POST_FLAIR: number = 25;
export const MIN_VOTES_FOR_USER_FLAIR: number =
  MIN_VOTES_TO_SHOW_ELO_IN_POST_FLAIR;
export const MAX_POST_AGE_TO_VOTE_MS: number = 24 * 60 * 60 * 1000;

export const MIN_ELO = 100;
export const MAX_ELO = 3000;
export const MAX_VOTE_POST_IMAGES: number = 5;
export const MAX_ANNOTATED_POST_IMAGES: number = 1;
export const MAX_POST_IMAGES: number = MAX_VOTE_POST_IMAGES;

// --- Classifications ---

export const Classification = {
  SUPERBRILLIANT: "Superbrilliant",
  BRILLIANT: "Brilliant",
  GREAT: "Great",
  BEST: "Best",
  EXCELLENT: "Excellent",
  GOOD: "Good",
  BOOK: "Book",
  FORCED: "Forced",
  INACCURACY: "Inaccuracy",
  MISTAKE: "Mistake",
  MISS: "Miss",
  BLUNDER: "Blunder",
  MEGABLUNDER: "Megablunder",
  INTERESTING: "Interesting",
} as const;

export type Classification =
  (typeof Classification)[keyof typeof Classification];

export const ResultVote = {
  ABANDON: "Abandon",
  CHECKMATED: "Checkmated",
  DRAW: "Draw",
  RESIGN: "Resign",
  TIMEOUT: "Timeout",
} as const;

export type ResultVote = (typeof ResultVote)[keyof typeof ResultVote];
export type BadgeVoteOption = Classification | ResultVote;

/** Picker order best→worst (all votable classifications) */
export const PICKER_CLASSIFICATIONS: Classification[] = [
  Classification.BRILLIANT,
  Classification.GREAT,
  Classification.BEST,
  Classification.EXCELLENT,
  Classification.GOOD,
  Classification.BOOK,
  Classification.FORCED,
  Classification.INACCURACY,
  Classification.MISTAKE,
  Classification.MISS,
  Classification.BLUNDER,
];

export const RESULT_PICKER_OPTIONS: ResultVote[] = [
  ResultVote.ABANDON,
  ResultVote.CHECKMATED,
  ResultVote.DRAW,
  ResultVote.RESIGN,
  ResultVote.TIMEOUT,
];

// No results section — removed Forced, Abandon, Checkmated, Draw, Resign, Timeout, Winner

/** Weighted score for IQM calculation */
export const CLASSIFICATION_WEIGHT: Record<Classification, number> = {
  [Classification.SUPERBRILLIANT]: 3,
  [Classification.BRILLIANT]: 3,
  [Classification.GREAT]: 2,
  [Classification.BEST]: 1,
  [Classification.EXCELLENT]: 0.5,
  [Classification.GOOD]: 0,
  [Classification.BOOK]: 0,
  [Classification.FORCED]: 0,
  [Classification.INACCURACY]: -0.5,
  [Classification.MISTAKE]: -1,
  [Classification.MISS]: -1,
  [Classification.BLUNDER]: -2,
  [Classification.MEGABLUNDER]: -2,
  [Classification.INTERESTING]: 0,
};

/** Badge display info */
export const BADGE_INFO: Record<
  Classification,
  { symbol: string; color: string; label: string }
> = {
  [Classification.SUPERBRILLIANT]: {
    symbol: "!!!",
    color: "#722f2c",
    label: "Superbrilliant",
  },
  [Classification.BRILLIANT]: {
    symbol: "!!",
    color: "#26c2a3",
    label: "Brilliant",
  },
  [Classification.GREAT]: { symbol: "!", color: "#749bbf", label: "Great" },
  [Classification.BEST]: { symbol: "★", color: "#81b64c", label: "Best" },
  [Classification.EXCELLENT]: {
    symbol: "👍",
    color: "#81b64c",
    label: "Excellent",
  },
  [Classification.GOOD]: { symbol: "✓", color: "#95b776", label: "Good" },
  [Classification.BOOK]: { symbol: "📖", color: "#d5a47d", label: "Book" },
  [Classification.FORCED]: {
    symbol: "!",
    color: "#95b776",
    label: "Forced",
  },
  [Classification.INACCURACY]: {
    symbol: "?!",
    color: "#f7c631",
    label: "Inaccuracy",
  },
  [Classification.MISTAKE]: { symbol: "?", color: "#ffa459", label: "Mistake" },
  [Classification.MISS]: { symbol: "✕", color: "#ff7769", label: "Miss" },
  [Classification.BLUNDER]: {
    symbol: "??",
    color: "#fa412d",
    label: "Blunder",
  },
  [Classification.MEGABLUNDER]: {
    symbol: "???",
    color: "#7d1811",
    label: "Megablunder",
  },
  [Classification.INTERESTING]: {
    symbol: "!?",
    color: "#7979a1",
    label: "Interesting",
  },
};

/** Hints — special classifications */
export const BADGE_HINTS: Partial<Record<Classification, string>> = {
  [Classification.BOOK]:
    "A standard opening message or a typical response(s) that follows.",
  [Classification.FORCED]:
    "The ONLY message that can realistically be sent in this position.",
  [Classification.MISS]:
    "Missed an obvious opportunity, cue, or context in the conversation.",
};

export const RESULT_INFO: Record<ResultVote, { label: string }> = {
  [ResultVote.ABANDON]: { label: "Abandon" },
  [ResultVote.CHECKMATED]: { label: "Checkmated" },
  [ResultVote.DRAW]: { label: "Draw" },
  [ResultVote.RESIGN]: { label: "Resign" },
  [ResultVote.TIMEOUT]: { label: "Timeout" },
};

export const RESULT_HINTS: Record<ResultVote, string> = {
  [ResultVote.ABANDON]: "One side abruptly bails on the conversation.",
  [ResultVote.CHECKMATED]:
    "A 'win' is secured (e.g., contact info given, a date agreed to, etc.).",
  [ResultVote.DRAW]: "The conversation ends amicably, albeit short of a 'win'.",
  [ResultVote.RESIGN]: "One side gives up and ends the interaction.",
  [ResultVote.TIMEOUT]:
    "The conversation dies as a result of waiting too long.",
};

export function isClassification(value: string): value is Classification {
  return Object.values(Classification).includes(value as Classification);
}

export function isResultVote(value: string): value is ResultVote {
  return Object.values(ResultVote).includes(value as ResultVote);
}

export function isBadgeVoteOption(value: string): value is BadgeVoteOption {
  return isClassification(value) || isResultVote(value);
}

// --- ELO ---

export const ELO_COLOR_STOPS = [
  { elo: 100, hex: "#fa412d" },
  { elo: 400, hex: "#ff7769" },
  { elo: 700, hex: "#ffa459" },
  { elo: 1000, hex: "#f7c631" },
  { elo: 1300, hex: "#95b776" },
  { elo: 1600, hex: "#81b64c" },
  { elo: 1900, hex: "#749bbf" },
  { elo: 2199, hex: "#26c2a3" },
  { elo: 2200, hex: "#722f2c" },
] as const;

// --- Data types ---

export type BadgePlacement = {
  id: string;
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  radius: number; // percentage of image width
  order?: number; // 0-indexed sequential
  classification?: BadgeVoteOption; // only for self-annotated
};

export type PostMode = "vote" | "annotated";
export type EloSide = "left" | "right" | "me" | "other";

export type PostImageData = {
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  placements: BadgePlacement[];
};

export type PostData = {
  mode: PostMode;
  images: PostImageData[];
  creatorId: string;
  title: string;
  createdAtMs?: number;
  eloSide?: EloSide;
  eloOtherText?: string;
  imageUrl?: string;
  placements?: BadgePlacement[];
};

export type BadgeConsensus = {
  classification: Classification | null;
  result: ResultVote | null;
  winningCategory: "classification" | "result" | null;
  winningVote: BadgeVoteOption | null;
  winningVotes: number;
  totalVotes: number;
  voteCounts: Partial<Record<Classification, number>>;
  iqm: number;
  resultTotalVotes: number;
  resultVoteCounts: Partial<Record<ResultVote, number>>;
};

export type InitResponse = {
  type: "init";
  postId: string;
  userId: string;
  isOwnPost: boolean;
  isModerator: boolean;
  postData: PostData | null;
  consensus: Record<string, BadgeConsensus>;
  userVotes: Record<string, BadgeVoteOption>;
  userElo: number | null;
  consensusElo: number | null;
  eloVoteCount: number;
};

export type CreatePostRequest = {
  title: string;
  images: Array<{
    imageData: string;
    imageMimeType: string;
    imageWidth: number;
    imageHeight: number;
    placements: BadgePlacement[];
  }>;
  mode: PostMode;
  eloSide?: EloSide;
  eloOtherText?: string;
};

export type CreatePostResponse = {
  type: "create-post";
  postId: string;
  postUrl: string;
};

export type UpdatePostRequest = {
  images: Array<{
    imageData: string;
    imageMimeType: string;
    imageWidth: number;
    imageHeight: number;
    placements: BadgePlacement[];
  }>;
};

export type UpdatePostResponse = {
  type: "update-post";
  postId: string;
  postUrl: string;
};

export type VoteBadgeRequest = {
  badgeId: string;
  classification: BadgeVoteOption;
};

export type VoteBadgeResponse = {
  type: "vote-badge";
  consensus: BadgeConsensus;
  allConsensus: Record<string, BadgeConsensus>;
  counted: boolean;
  invalidatedBadgeIds?: string[];
};

export type VoteEloRequest = {
  elo: number;
};

export type VoteEloResponse = {
  type: "vote-elo";
  consensusElo: number;
  voteCount: number;
  counted: boolean;
  targetLabel: string;
};

// --- API endpoints ---

export const ApiEndpoint = {
  Init: "/api/init",
  CreatePost: "/api/create-post",
  UpdatePost: "/api/update-post",
  VoteBadge: "/api/vote-badge",
  VoteElo: "/api/vote-elo",
  MenuCreate: "/internal/menu/create",
  MenuCommentReplyClassification: "/internal/menu/comment-reply-classification",
  FormCommentReplyClassification:
    "/internal/forms/comment-reply-classification",
} as const;

export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

// --- Consensus helpers ---

export const INTERESTING_LOWER_BOUND: Classification = Classification.MISTAKE;
export const INTERESTING_UPPER_BOUND: Classification = Classification.BEST;

/**
 * Interquartile Mean — trims 25% from each end, averages the middle 50%.
 * Uses a robust interquartile-mean approach to reduce outlier impact.
 */
export function interquartileMean(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0]!;

  const sorted = [...values].sort((a, b) => a - b);
  const trimProportion = 0.25;
  const trimAmount = n * trimProportion;
  const k = Math.floor(trimAmount);
  const g = trimAmount - k;

  const coreSlice = sorted.slice(k + 1, n - (k + 1));
  let weightedSum = coreSlice.reduce((acc, v) => acc + v, 0);

  const boundaryWeight = 1 - g;
  weightedSum += sorted[k]! * boundaryWeight;
  weightedSum += sorted[n - 1 - k]! * boundaryWeight;

  const totalWeight = n - 2 * trimAmount;
  return weightedSum / totalWeight;
}

/** Map IQM score → nearest standard classification */
export function iqmToClassification(
  iqm: number,
  voteCounts: Partial<Record<Classification, number>>,
  totalVotes: number,
): Classification {
  const { q1, q3 } = interquartileWeightedBounds(voteCounts, totalVotes);
  const interestingLowerWeight = CLASSIFICATION_WEIGHT[INTERESTING_LOWER_BOUND];
  const interestingUpperWeight = CLASSIFICATION_WEIGHT[INTERESTING_UPPER_BOUND];
  if (q1 <= interestingLowerWeight && q3 >= interestingUpperWeight) {
    return Classification.INTERESTING;
  }

  const iqmVoteMass = interquartileVoteMassByClassification(voteCounts);
  const iqmTotalVotes = Math.max(0, iqmVoteMass.total);
  if (iqmTotalVotes > 0) {
    const bookIqmShare =
      (iqmVoteMass.byClassification[Classification.BOOK] ?? 0) / iqmTotalVotes;
    if (bookIqmShare > 0.5 && -0.25 <= iqm && iqm < 0.25) {
      return Classification.BOOK;
    }

    const forcedIqmShare =
      (iqmVoteMass.byClassification[Classification.FORCED] ?? 0) /
      iqmTotalVotes;
    if (forcedIqmShare > 0.75 && -0.25 <= iqm && iqm < 0.25) {
      return Classification.FORCED;
    }

    const missIqmShare =
      (iqmVoteMass.byClassification[Classification.MISS] ?? 0) / iqmTotalVotes;
    if (missIqmShare > 0.5 && iqm < 0) {
      return Classification.MISS;
    }
  }

  // Standard mapping
  if (iqm >= 2.75) return Classification.SUPERBRILLIANT;
  if (iqm >= 2.5) return Classification.BRILLIANT;
  if (iqm >= 1.5) return Classification.GREAT;
  if (iqm >= 0.75) return Classification.BEST;
  if (iqm >= 0.25) return Classification.EXCELLENT;
  if (iqm >= -0.25) return Classification.GOOD;
  if (iqm >= -0.75) return Classification.INACCURACY;
  if (iqm >= -1.5) return Classification.MISTAKE;
  if (iqm >= -1.75) return Classification.BLUNDER;
  return Classification.MEGABLUNDER;
}

function interquartileVoteMassByClassification(
  voteCounts: Partial<Record<Classification, number>>,
): {
  byClassification: Partial<Record<Classification, number>>;
  total: number;
} {
  const byClassification: Partial<Record<Classification, number>> = {};
  const buckets = new Map<
    number,
    { total: number; byClass: Map<Classification, number> }
  >();
  let n = 0;

  for (const [classification, rawCount] of Object.entries(voteCounts)) {
    const cls = classification as Classification;
    const count = rawCount ?? 0;
    if (count <= 0) continue;
    const weight = CLASSIFICATION_WEIGHT[cls] ?? 0;
    const bucket =
      buckets.get(weight) ??
      (() => {
        const created = {
          total: 0,
          byClass: new Map<Classification, number>(),
        };
        buckets.set(weight, created);
        return created;
      })();
    bucket.total += count;
    bucket.byClass.set(cls, (bucket.byClass.get(cls) ?? 0) + count);
    n += count;
  }

  if (n <= 0) {
    return { byClassification, total: 0 };
  }

  const trimAmount = n * 0.25;
  let lowerTrimRemaining = trimAmount;
  let upperTrimRemaining = trimAmount;
  const weightsAsc = [...buckets.keys()].sort((a, b) => a - b);
  const lowerTrimByWeight = new Map<number, number>();
  const upperTrimByWeight = new Map<number, number>();

  for (const weight of weightsAsc) {
    if (lowerTrimRemaining <= 0) break;
    const bucket = buckets.get(weight);
    if (!bucket) continue;
    const trimmed = Math.min(lowerTrimRemaining, bucket.total);
    if (trimmed > 0) {
      lowerTrimByWeight.set(weight, trimmed);
      lowerTrimRemaining -= trimmed;
    }
  }

  for (let index = weightsAsc.length - 1; index >= 0; index -= 1) {
    if (upperTrimRemaining <= 0) break;
    const weight = weightsAsc[index]!;
    const bucket = buckets.get(weight);
    if (!bucket) continue;
    const trimmed = Math.min(upperTrimRemaining, bucket.total);
    if (trimmed > 0) {
      upperTrimByWeight.set(weight, trimmed);
      upperTrimRemaining -= trimmed;
    }
  }

  for (const weight of weightsAsc) {
    const bucket = buckets.get(weight);
    if (!bucket || bucket.total <= 0) continue;

    const lowerTrim = lowerTrimByWeight.get(weight) ?? 0;
    const upperTrim = upperTrimByWeight.get(weight) ?? 0;
    const included = Math.max(0, bucket.total - lowerTrim - upperTrim);
    if (included <= 0) continue;

    for (const [cls, classCount] of bucket.byClass.entries()) {
      if (classCount <= 0) continue;
      const classShareInBucket = classCount / bucket.total;
      const includedForClass = included * classShareInBucket;
      byClassification[cls] = (byClassification[cls] ?? 0) + includedForClass;
    }
  }

  const total = Math.max(0, n - 2 * trimAmount);
  return { byClassification, total };
}

function interquartileWeightedBounds(
  voteCounts: Partial<Record<Classification, number>>,
  totalVotes: number,
): { q1: number; q3: number } {
  if (totalVotes <= 1) return { q1: 0, q3: 0 };

  const values: number[] = [];
  for (const [classification, count] of Object.entries(voteCounts)) {
    const votes = count ?? 0;
    if (votes <= 0) continue;
    const weight = CLASSIFICATION_WEIGHT[classification as Classification] ?? 0;
    for (let i = 0; i < votes; i++) values.push(weight);
  }

  if (values.length <= 1) return { q1: 0, q3: 0 };
  const sorted = values.sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return { q1, q3 };
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const clampedQ = Math.max(0, Math.min(1, q));
  const index = (sortedValues.length - 1) * clampedQ;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower]!;
  const t = index - lower;
  return sortedValues[lower]! * (1 - t) + sortedValues[upper]! * t;
}

/** Interpolate ELO color from color stops */
export function getEloColor(elo: number): string {
  const first = ELO_COLOR_STOPS[0]!;
  const last = ELO_COLOR_STOPS[ELO_COLOR_STOPS.length - 1]!;
  if (elo <= first.elo) return first.hex;
  if (elo >= last.elo) return last.hex;

  for (let i = 0; i < ELO_COLOR_STOPS.length - 1; i++) {
    const a = ELO_COLOR_STOPS[i]!;
    const b = ELO_COLOR_STOPS[i + 1]!;
    if (a.elo === b.elo) continue;
    if (elo >= a.elo && elo <= b.elo) {
      const t = (elo - a.elo) / (b.elo - a.elo);
      return lerpHex(a.hex, b.hex, t);
    }
  }
  return last.hex;
}

function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16),
    ag = parseInt(a.slice(3, 5), 16),
    ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16),
    bg = parseInt(b.slice(3, 5), 16),
    bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}
