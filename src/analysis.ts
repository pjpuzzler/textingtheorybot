export enum Classification {
  SUPERBRILLIANT = "Superbrilliant",
  BRILLIANT = "Brilliant",
  GREAT = "Great",
  BEST = "Best",
  EXCELLENT = "Excellent",
  GOOD = "Good",
  BOOK = "Book",
  INACCURACY = "Inaccuracy",
  MISTAKE = "Mistake",
  MISS = "Miss",
  BLUNDER = "Blunder",
  MEGABLUNDER = "Megablunder",
  FORCED = "Forced",
  INTERESTING = "Interesting",
  PASS = "Pass",
  ABANDON = "Abandon",
  CHECKMATED = "Checkmated",
  DRAW = "Draw",
  RESIGN = "Resign",
  TIMEOUT = "Timeout",
  WINNER = "Winner",
}

export type CountedClassification =
  | Classification.SUPERBRILLIANT
  | Classification.BRILLIANT
  | Classification.GREAT
  | Classification.BEST
  | Classification.EXCELLENT
  | Classification.GOOD
  | Classification.BOOK
  | Classification.INACCURACY
  | Classification.MISTAKE
  | Classification.MISS
  | Classification.BLUNDER
  | Classification.MEGABLUNDER;

export type RedditComment = {
  username: string;
  content: string;
  classification?: Classification;
};

export type Message = {
  side: "left" | "right";
  content: string;
  classification: Classification;
  // unsent: boolean;
};

export type EloBlock = {
  left?: number;
  right?: number;
};

export type ColorInfo = {
  label: string;
  bubble_hex: string;
  text_hex: string;
};

export type ColorBlock = {
  left?: ColorInfo;
  right?: ColorInfo;
  background_hex: string;
};

export type Analysis = {
  messages: Message[];
  elo?: EloBlock;
  color: ColorBlock;
  opening_name: string;
  comment: string;
  not_analyzable: boolean;
  vote_target?: "left" | "right";
};
