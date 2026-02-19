// ============================================================
// Texting Theory Bot — Shared API Types & Constants
// ============================================================

// --- Tuning constants (single source of truth) ---

export const MIN_VOTES_FOR_BADGE_CONSENSUS = 10;
export const MIN_VOTES_FOR_ELO_CONSENSUS = 100;
export const MIN_VOTES_FOR_POST_FLAIR = 1;
export const MIN_VOTES_FOR_USER_FLAIR: number = MIN_VOTES_FOR_ELO_CONSENSUS;

export const MIN_ELO = 100;
export const MAX_ELO = 3000;
export const MAX_VOTE_POST_IMAGES: number = 3;
export const MAX_ANNOTATED_POST_IMAGES: number = 1;
export const MAX_POST_IMAGES: number = MAX_VOTE_POST_IMAGES;

// --- Classifications ---

export const Classification = {
  BRILLIANT: "Brilliant",
  GREAT: "Great",
  BOOK: "Book",
  BEST: "Best",
  EXCELLENT: "Excellent",
  GOOD: "Good",
  INACCURACY: "Inaccuracy",
  MISTAKE: "Mistake",
  MISS: "Miss",
  BLUNDER: "Blunder",
  INTERESTING: "Interesting",
} as const;

export type Classification =
  (typeof Classification)[keyof typeof Classification];

/** Picker order best→worst (all votable classifications) */
export const PICKER_CLASSIFICATIONS: Classification[] = [
  Classification.BRILLIANT,
  Classification.GREAT,
  Classification.BOOK,
  Classification.BEST,
  Classification.EXCELLENT,
  Classification.GOOD,
  Classification.INACCURACY,
  Classification.MISTAKE,
  Classification.MISS,
  Classification.BLUNDER,
];

// No results section — removed Forced, Abandon, Checkmated, Draw, Resign, Timeout, Winner

/** Weighted score for IQM calculation */
export const CLASSIFICATION_WEIGHT: Record<Classification, number> = {
  [Classification.BRILLIANT]: 3,
  [Classification.GREAT]: 2,
  [Classification.BEST]: 1,
  [Classification.EXCELLENT]: 0.5,
  [Classification.BOOK]: 0,
  [Classification.GOOD]: 0,
  [Classification.INACCURACY]: -0.5,
  [Classification.MISTAKE]: -1,
  [Classification.MISS]: -1,
  [Classification.BLUNDER]: -2,
  [Classification.INTERESTING]: 0,
};

/** Badge display info */
export const BADGE_INFO: Record<
  Classification,
  { symbol: string; color: string; label: string }
> = {
  [Classification.BRILLIANT]: {
    symbol: "!!",
    color: "#26c2a3",
    label: "Brilliant",
  },
  [Classification.GREAT]: { symbol: "!", color: "#749bbf", label: "Great" },
  [Classification.BOOK]: { symbol: "📖", color: "#d5a47d", label: "Book" },
  [Classification.BEST]: { symbol: "★", color: "#81b64c", label: "Best" },
  [Classification.EXCELLENT]: {
    symbol: "👍",
    color: "#81b64c",
    label: "Excellent",
  },
  [Classification.GOOD]: { symbol: "✓", color: "#95b776", label: "Good" },
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
  [Classification.INTERESTING]: {
    symbol: "!?",
    color: "#7979a1",
    label: "Interesting",
  },
};

/** Hints — only Book and Miss */
export const BADGE_HINTS: Partial<Record<Classification, string>> = {
  [Classification.BOOK]:
    "A common, expected opener or standard follow-up. Must be the first message or follow another Book.",
  [Classification.MISS]:
    "Missed an important opportunity, cue, or context in the conversation.",
};

// --- ELO ---

export const ELO_COLOR_STOPS = [
  { elo: 100, hex: "#fa412d" },
  { elo: 375, hex: "#ff7769" },
  { elo: 650, hex: "#ffa459" },
  { elo: 925, hex: "#f7c631" },
  { elo: 1200, hex: "#95b776" },
  { elo: 1475, hex: "#81b64c" },
  { elo: 1750, hex: "#749bbf" },
  { elo: 2025, hex: "#26c2a3" },
  { elo: 2200, hex: "#722f2c" },
] as const;

// --- Data types ---

export type BadgePlacement = {
  id: string;
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  radius: number; // percentage of image width
  order?: number; // 0-indexed sequential
  classification?: Classification; // only for self-annotated
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
  eloSide?: EloSide;
  eloOtherText?: string;
  imageUrl?: string;
  placements?: BadgePlacement[];
};

export type BadgeConsensus = {
  classification: Classification | null;
  totalVotes: number;
  voteCounts: Partial<Record<Classification, number>>;
  iqm: number;
};

export type InitResponse = {
  type: "init";
  postId: string;
  username: string;
  userId: string;
  postData: PostData | null;
  consensus: Record<string, BadgeConsensus>;
  userVotes: Record<string, Classification>;
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

export type VoteBadgeRequest = {
  badgeId: string;
  classification: Classification;
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
  VoteBadge: "/api/vote-badge",
  VoteElo: "/api/vote-elo",
  MenuCreate: "/internal/menu/create",
} as const;

export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

// --- Consensus helpers ---

export const BOOK_MIN_SHARE = 0.5;
export const BOOK_IQM_RANGE = [-1, 1] as const; // exclusive
export const MISS_MIN_SHARE = 0.5;
export const MISS_IQM_RANGE = [-2, 0] as const; // exclusive
export const INTERESTING_STD_DEV_THRESHOLD = 1.5;

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
  // Special: Book
  const bookShare = (voteCounts[Classification.BOOK] ?? 0) / totalVotes;
  if (
    bookShare >= BOOK_MIN_SHARE &&
    iqm > BOOK_IQM_RANGE[0] &&
    iqm < BOOK_IQM_RANGE[1]
  ) {
    return Classification.BOOK;
  }

  // Special: Miss
  const missShare = (voteCounts[Classification.MISS] ?? 0) / totalVotes;
  if (
    missShare >= MISS_MIN_SHARE &&
    iqm > MISS_IQM_RANGE[0] &&
    iqm < MISS_IQM_RANGE[1]
  ) {
    return Classification.MISS;
  }

  // Standard mapping
  if (iqm >= 2.5) return Classification.BRILLIANT;
  if (iqm >= 1.5) return Classification.GREAT;
  if (iqm >= 0.75) return Classification.BEST;
  if (iqm >= 0.25) return Classification.EXCELLENT;
  if (iqm >= -0.25) return Classification.GOOD;
  if (iqm >= -0.75) return Classification.INACCURACY;
  if (iqm >= -1.5) return Classification.MISTAKE;
  return Classification.BLUNDER;
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
