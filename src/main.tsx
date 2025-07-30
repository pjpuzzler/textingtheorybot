import {
  Devvit,
  Comment,
  RichTextBuilder,
  SetPostFlairOptions,
  SettingScope,
  TriggerContext,
} from "@devvit/public-api";
import { PostV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/postv2.js";
import { UserV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/userv2.js";
import {
  createPartFromBase64,
  GoogleGenAI,
  createUserContent,
  HarmCategory,
  HarmBlockThreshold,
  Type,
} from "@google/genai";
import { Index, Pinecone, RecordMetadata } from "@pinecone-database/pinecone";
import {
  MEGABLUNDER_TEXT,
  SUPERBRILLIANT_TEXT,
  SYSTEM_PROMPT,
} from "./systemPrompt.js";
import {
  AccuracyClassification,
  Analysis,
  Classification,
  CountedClassification,
  Message,
  PineconeMatch,
  RedditComment,
} from "./analysis.js";
import { getEloColor } from "./color.js";

const MIN_VOTE_VALUE = 100;
const MAX_VOTE_VALUE = 3000;
const MIN_VOTES_FOR_POST_FLAIR = 1;
const MIN_KARMA_TO_VOTE = 10;
const MIN_AGE_TO_VOTE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_VOTES_FOR_USER_FLAIR = 10;

const TITLE_ME_VOTE_REGEX = /^\[me\b.*\]/i;
const ELO_VOTE_REGEX = /!elo (\d+)\b/i;
const ELO_REGEX = /(\d+) Elo/;
const ANNOTATION_REGEX = /Annotated by (u\/[A-Za-z0-9_-]+)/;
const IMPLIED_MESSAGE_REGEX = /^\*.*\*$/;

const REQUESTING_ANNOTATION_FLAIR_ID = "a79dfdbc-4b09-11f0-a6f6-e2bae3f86d0a",
  ALREADY_ANNOTATED_FLAIR_ID = "c2d007e7-ca1c-11eb-bc34-0e56c289897d",
  MEGABLUNDER_MONDAY_FLAIR_ID = "a41e2978-4c76-11f0-a7d9-8a051a625ee6",
  SUPERBRILLIANT_SATURDAY_FLAIR_ID = "b4df51ec-4c76-11f0-8011-568335338cf7",
  META_FLAIR_ID = "edde53c6-7cb1-11ee-8104-3e49ebced071",
  ANNOUNCEMENT_FLAIR_ID = "dd6d2d40-ca1c-11eb-8d7e-0ec8e8045baf";

const NO_ANALYSIS_FLAIR_IDS = [META_FLAIR_ID, ANNOUNCEMENT_FLAIR_ID];

const CUSTOM_1_FLAIR_ID = "22828506-cad6-11eb-ba90-0e07bb4c3bf9";
const CUSTOM_2_FLAIR_ID = "e6adfe7c-4a18-11f0-95e9-0a262c404227";

const NO_ELO_USER_FLAIR_IDS = [CUSTOM_1_FLAIR_ID, CUSTOM_2_FLAIR_ID];

const TEXTFISH_FLAIR_TEMPLATE_ID = "65d18ba6-5e8c-11f0-ba88-065f6e5afca9";

const POST_DATA_PREFIX = "post_data:";
const COMMENT_CHAIN_DATA_PREFIX = "comment_chain:";
const VOTERS_PREFIX = "voters:";
const LEADERBOARD_KEY = "elo_leaderboard";
const ANALYSIS_COUNT_KEY = "analysis_count";

const RENDER_INITIAL_DELAY = 15000;
const RENDER_POLL_DELAY = 5000;
const MAX_RENDER_POLL_ATTEMPTS = 3;

const BANNED_VOTE_VALUES = [
  420, 1234, 123, 234, 2345, 321, 1488, 109, 1738, 911, 2001, 1337, 1984, 1945,
  1939, 1914, 111, 101, 1111, 222, 2222, 333, 444, 555, 666, 777, 888, 999,
  1776, 2025, 169, 269, 369, 469, 569, 669, 769, 869, 969, 1069, 1169, 1269,
  1369, 1469, 1569, 1669, 1769, 1869, 1969, 2069, 2169, 2269, 2369, 2469, 2569,
  2669, 2769, 2869, 2969, 690, 691, 692, 693, 694, 695, 696, 697, 698, 699,
  1666, 2666, 1420, 2420, 1123, 2123, 1321, 1911, 1691,
];

const MAX_SIMILAR_CONVERSATIONS = 3;
const MIN_CONVERSATION_SIMILARITY_SCORE = 0.9;

const CLASSIFICATION_ACCURACY_INFO: Record<
  AccuracyClassification,
  { accuracy: number; radius: number }
> = {
  [Classification.SUPERBRILLIANT]: { accuracy: 100, radius: 0 },
  [Classification.BRILLIANT]: { accuracy: 100, radius: 0 },
  [Classification.GREAT]: { accuracy: 100, radius: 0 },
  [Classification.BEST]: { accuracy: 100, radius: 0 },
  [Classification.EXCELLENT]: { accuracy: 99, radius: 1 },
  [Classification.GOOD]: { accuracy: 96.5, radius: 1.5 },
  [Classification.BOOK]: { accuracy: 100, radius: 2 },
  [Classification.INACCURACY]: { accuracy: -7.5, radius: 2.5 },
  [Classification.MISTAKE]: { accuracy: -15, radius: 5 },
  [Classification.MISS]: { accuracy: -10, radius: 3 },
  [Classification.BLUNDER]: { accuracy: -60, radius: 40 },
  [Classification.MEGABLUNDER]: { accuracy: -100, radius: 0 },
};

const CLASSIFICATION_UNICODES: Record<CountedClassification, string> = {
  [Classification.SUPERBRILLIANT]: "!!!",
  [Classification.BRILLIANT]: "!!",
  [Classification.GREAT]: "!",
  [Classification.BEST]: "★",
  [Classification.MISTAKE]: "?",
  [Classification.MISS]: "X",
  [Classification.BLUNDER]: "??",
  [Classification.MEGABLUNDER]: "???",
};

const GITHUB_DISPATCH_URL =
  "https://api.github.com/repos/pjpuzzler/textingtheory-renderer/dispatches";

const ABOUT_THE_BOT_LINK =
    "https://www.reddit.com/r/TextingTheory/comments/1k8fed9/utextingtheorybot/",
  ICON_MEANINGS_LINK =
    "https://www.reddit.com/r/TextingTheory/comments/1ksad21/classifications_badges_explained/",
  WHAT_IS_ELO_LINK =
    "https://www.reddit.com/r/TextingTheory/comments/1m1o8jl/what_is_elo/",
  MORE_ANNOTATION_INFO_LINK =
    "https://www.reddit.com/r/TextingTheory/comments/1lmnlr6/manual_annotations_guide/";

Devvit.configure({
  http: true,
  media: true,
  redditAPI: true,
  redis: true,
  userActions: true,
});

Devvit.addSettings([
  {
    type: "string",
    name: "GITHUB_TOKEN",
    label: "GitHub Personal Access Token",
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: "string",
    name: "GEMINI_API_KEY",
    label: "Google Gemini API Key",
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: "string",
    name: "PINECONE_API_KEY",
    label: "Pinecone DB API Key",
    scope: SettingScope.App,
    isSecret: true,
  },
]);

function getGeminiConfig() {
  const dayOfWeek = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  });
  const validClassifications = Object.values(Classification).filter((c) => {
    if (c === Classification.MEGABLUNDER) return dayOfWeek === "Monday";
    if (c === Classification.SUPERBRILLIANT) return dayOfWeek === "Saturday";
    return true;
  });

  let finalSystemPrompt = SYSTEM_PROMPT.replace(
    "// ANCHOR_FOR_SUPERBRILLIANT",
    dayOfWeek === "Saturday" ? SUPERBRILLIANT_TEXT : ""
  ).replace(
    "// ANCHOR_FOR_MEGABLUNDER",
    dayOfWeek === "Monday" ? MEGABLUNDER_TEXT : ""
  );

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      messages: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            side: { type: Type.STRING, enum: ["left", "right"] },
            content: { type: Type.STRING },
            classification: {
              type: Type.STRING,
              enum: validClassifications,
            },
          },
          required: ["side", "content", "classification"],
        },
      },
      elo: {
        type: Type.OBJECT,
        description: "Estimated Elo ratings for the players.",
        properties: {
          left: {
            type: Type.INTEGER,
            minimum: 100,
            maximum: 3000,
            description: `Estimated Elo (integer) for the "left" player.`,
            nullable: true,
          },
          right: {
            type: Type.INTEGER,
            minimum: 100,
            maximum: 3000,
            description: `Estimated Elo (integer) for the "right" player.`,
            nullable: true,
          },
        },
      },
      color: {
        type: Type.OBJECT,
        description: "Color theme for the chat display.",
        properties: {
          left: {
            type: Type.OBJECT,
            description: `Color info for the "left" player. Omit if no messages from "left".`,
            nullable: true,
            properties: {
              label: {
                type: Type.STRING,
                description: `Simple, one-word color name (e.g., "Gray")`,
              },
              bubble_hex: {
                type: Type.STRING,
                description: "Hex code for the message bubble.",
              },
              text_hex: {
                type: Type.STRING,
                description: "Hex code for the text color.",
              },
            },
            required: ["label", "bubble_hex", "text_hex"],
          },
          right: {
            type: Type.OBJECT,
            description: `Color info for the "right" player. Omit if no messages from "right".`,
            nullable: true,
            properties: {
              label: {
                type: Type.STRING,
                description: `Simple, one-word color name (e.g., "Purple")`,
              },
              bubble_hex: {
                type: Type.STRING,
                description: "Hex code for the message bubble.",
              },
              text_hex: {
                type: Type.STRING,
                description: "Hex code for the text color.",
              },
            },
            required: ["label", "bubble_hex", "text_hex"],
          },
          background_hex: {
            type: Type.STRING,
            description: "Hex code for the overall chat background.",
          },
        },
        required: ["background_hex"],
      },
      opening_name: {
        type: Type.STRING,
        description: "A creative opening name for the game.",
      },
      comment: {
        type: Type.STRING,
        description: "A one-sentence comment on the game.",
      },
      vote_target: {
        type: Type.STRING,
        enum: ["left", "right"],
        description:
          "If the Reddit post title brackets indicates a vote is being requested for one player (e.g., '[Me]', '[Left]', '[Blue]' etc.), which side ('left' or 'right') you think the vote is for. Omit if no vote is requested in the title.",
        nullable: true,
      },
    },
    required: ["messages", "elo", "color", "opening_name", "comment"],
  };

  return {
    systemInstruction: finalSystemPrompt,
    responseSchema: responseSchema,
  };
}

function formatDateAsPath(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}/${month}/${day}`;
}

function normalizeClassifications(analysis: Analysis): void {
  const messages = analysis.messages;
  const isFinalizing = (cls: Classification) =>
    cls === Classification.ABANDON ||
    cls === Classification.CHECKMATED ||
    cls === Classification.RESIGN ||
    cls === Classification.TIMEOUT;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = messages[i - 1];
    const next = messages[i + 1];

    if (
      msg.classification === Classification.BOOK &&
      i > 0 &&
      prev.classification !== Classification.BOOK
    )
      msg.classification = Classification.GOOD;

    if (
      isFinalizing(msg.classification) &&
      (i < messages.length - 2 ||
        (i === messages.length - 2 &&
          !(
            next.classification === Classification.WINNER &&
            next.side !== msg.side
          )))
    )
      msg.classification = Classification.GOOD;

    if (
      msg.classification === Classification.WINNER &&
      // (
      i < messages.length - 1
      // || !(prev && prev.side !== msg.side && isFinalizing(prev.classification))
      // )
    )
      msg.classification = Classification.GOOD;

    if (
      msg.classification === Classification.DRAW &&
      (i < messages.length - 2 ||
        (i === messages.length - 2 &&
          !(
            next.classification === Classification.DRAW &&
            next.side !== msg.side
          )))
    )
      msg.classification = Classification.GOOD;
  }
}

function getNormalizedCommentBody(
  botUsername: string,
  comment: Comment
): string {
  if (comment.authorName === botUsername) {
    const annotationMatch = comment.body.match(ANNOTATION_REGEX);
    return annotationMatch
      ? `[${annotationMatch[1]}'s annotation]`
      : "[Game Review]";
  }

  let body = comment.body;

  // Replace preview.redd.it image links with [image]
  body = body.replace(
    /https?:\/\/preview\.redd\.it\/[\w\-\?=&#%\.]+/g,
    "[image]"
  );

  // Replace markdown links [text](url) with just text
  body = body.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

  // Unescape all escaped markdown characters (keep the character, remove the backslash)
  body = body.replace(/\\([*_~`\[\]()^#\\+\-])/g, "$1");

  // Remove bold (**text**)
  body = body.replace(/\*\*(.*?)\*\*/g, "$1");

  // Remove italic (*text*)
  body = body.replace(/\*(.*?)\*/g, "$1");

  // Remove strikethrough (~~text~~)
  body = body.replace(/~~(.*?)~~/g, "$1");

  // Remove superscript ^(...)
  body = body.replace(/\^\((.*?)\)/g, "$1");

  // Remove heading (# at start of line)
  body = body.replace(/^#+\s?/gm, "");

  // Replace spoiler >!text!< with just text
  body = body.replace(/>!(.*?)!</g, "$1");

  // Remove quote block (> at start of line)
  body = body.replace(/^>\s?/gm, "");

  // Remove code formatting (backticks around text)
  body = body.replace(/`([^`]*)`/g, "$1");

  return body;
}

function getConvoText(messages: Message[]): string {
  return messages.map((msg) => `${msg.side}: ${msg.content}`).join("\n");
}

async function getEmbedding(
  ai: GoogleGenAI,
  convoText: string
): Promise<number[]> {
  const res = await ai.models.embedContent({
    model: "gemini-embedding-exp-03-07",
    contents: convoText,
    config: {
      outputDimensionality: 3072,
      taskType: "SEMANTIC_SIMILARITY",
    },
  });
  return res.embeddings![0].values!;
}

async function findSimilarConversations(
  pineconeIndex: Index<RecordMetadata>,
  embedding: number[]
): Promise<PineconeMatch[]> {
  const queryResult = await pineconeIndex.query({
    vector: embedding,
    topK: MAX_SIMILAR_CONVERSATIONS,
  });

  return queryResult.matches
    .filter(
      (match) => match.score && match.score >= MIN_CONVERSATION_SIMILARITY_SCORE
    )
    .map((match) => ({ id: match.id, score: match.score! }));
}

async function getGeminiAnalysis(
  ai: GoogleGenAI,
  imageUrls: string[],
  postId: string,
  postTitle: string,
  postBody: string | undefined
): Promise<Analysis | undefined> {
  if (!imageUrls.length) {
    console.log(
      `[${postId}] No processable images found in post or its source. Skipping.`
    );
    return;
  }

  console.log(
    `[${postId}] Found ${imageUrls.length} image(s) to analyze. Fetching content...`
  );

  const geminiImageParts = [];

  try {
    const imageFetchPromises = imageUrls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(
          `[${postId}] Failed to fetch image at ${url}: ${response.status} ${response.statusText}`
        );
        return null;
      }
      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") || "image/jpeg";
      return createPartFromBase64(imageBuffer.toString("base64"), contentType);
    });

    const results = await Promise.all(imageFetchPromises);
    for (const part of results) {
      if (part) {
        geminiImageParts.push(part);
      }
    }
  } catch (error) {
    console.error(
      `[${postId}] An error occurred while fetching images: ${error}`
    );
    return;
  }

  if (!geminiImageParts.length) {
    console.log(
      `[${postId}] All image fetches failed or returned no data. Skipping.`
    );
    return;
  }

  const dynamicConfig = getGeminiConfig();

  console.log(
    `[${postId}] Sending ${geminiImageParts.length} image(s) to Gemini with a structured schema.`
  );

  const geminiResponse = await ai.models.generateContent({
    // model: "gemini-2.5-flash",
    model: "gemini-2.5-pro",
    contents: [
      createUserContent([
        `Reddit Post Title: "${postTitle}"\n\nReddit Post Body: "${
          postBody ?? ""
        }"`,
        ...geminiImageParts,
      ]),
    ],
    config: {
      ...dynamicConfig,
      temperature: 0,
      responseMimeType: "application/json",
      thinkingConfig: {
        // thinkingBudget: 1024,
        // thinkingBudget: 24576,
        thinkingBudget: -1,
        // thinkingBudget: 128,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.OFF,
        },
        {
          category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          threshold: HarmBlockThreshold.OFF,
        },
      ],
    },
  });

  const geminiResponseText = geminiResponse.text;

  if (!geminiResponseText) {
    console.log(
      `[${postId}] Gemini gave an undefined or empty response text. Skipping.`
    );
    return;
  }

  let analysis: Analysis;
  try {
    analysis = JSON.parse(geminiResponseText);
  } catch (parseError) {
    console.error(
      `[${postId}] Failed to parse Gemini JSON response: ${parseError}`,
      geminiResponseText
    );
    return;
  }

  console.log(
    `[${postId}] Parsed Gemini response: ${JSON.stringify(analysis)}`
  );

  return analysis;
}

async function dispatchGitHubAction(
  context: TriggerContext,
  uid: string,
  renderData: Analysis | RedditComment[],
  command: string
): Promise<void> {
  const { settings } = context;

  console.log(`${[uid]} Dispatching GitHub Action to render image...`);
  const token = (await settings.get("GITHUB_TOKEN")) as string;
  if (!token) throw new Error("Missing GitHub token in the app configuration.");

  const dispatchResponse = await fetch(GITHUB_DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: command,
      client_payload: {
        uid,
        render_payload: renderData,
      },
    }),
  });

  if (!dispatchResponse.ok) {
    const errorText = await dispatchResponse.text();
    throw new Error(
      `Failed to dispatch GitHub Action: ${dispatchResponse.status} ${errorText}`
    );
  }
  console.log(`${[uid]} GitHub Action dispatched successfully.`);
}

const annotateAnalysisForm = Devvit.createForm(
  (data) => ({
    title: "Annotate Post",
    acceptLabel: "Submit",
    fields: [
      ...data.analysis.messages.map((msg: Message, idx: number) => ({
        type: "group",
        label: msg.content,
        fields: [
          {
            name: `side_${idx}`,
            type: "select",
            label: "Side",
            options: [
              { label: "Left", value: "left" },
              { label: "Right", value: "right" },
            ],
            defaultValue: [msg.side],
            required: true,
          },
          {
            name: `classification_${idx}`,
            type: "select",
            label: "Classification",
            options: Object.values(Classification)
              .filter((c) => {
                if (c === Classification.MEGABLUNDER)
                  return msg.classification === Classification.MEGABLUNDER;
                if (c === Classification.SUPERBRILLIANT)
                  return msg.classification === Classification.SUPERBRILLIANT;
                return true;
              })
              .map((value) => ({
                label: value,
                value,
              })),
            defaultValue: [msg.classification],
            required: true,
          },
        ],
      })),
      {
        name: "pm_annotation",
        label: "PM you the result?",
        helpText: "(as opposed to the bot posting it for you)",
        type: "boolean",
        defaultValue: false,
      },
    ],
  }),
  async (event, context) => {
    const { values } = event;
    const { postId, redis, scheduler, ui, userId } = context;

    try {
      const postData = await redis.hGetAll(`${POST_DATA_PREFIX}${postId}`);

      const analysis: Analysis = JSON.parse(postData.analysis);
      for (let i = 0; i < analysis.messages.length; i++) {
        analysis.messages[i].side = values[`side_${i}`][0];
        analysis.messages[i].classification = values[`classification_${i}`][0];
      }

      const uid = `annotate_${postId}_${userId}_${Date.now().toString()}`;

      await dispatchGitHubAction(context, uid, analysis, "render_and_upload");

      const runAt = new Date(Date.now() + RENDER_INITIAL_DELAY);

      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          originalId: postId!,
          uid,
          requestingUserId: userId!,
          pmAnnotation: values.pm_annotation,
          type: "annotate",
        },
        runAt,
      });

      ui.showToast({
        text: `Submitted successfully, please check back in ~${Math.floor(
          (RENDER_INITIAL_DELAY + RENDER_POLL_DELAY) / 1000
        )}s`,
        appearance: "success",
      });
    } catch (e: any) {
      ui.showToast("An unexpected error occured");
    }
  }
);

const annotateRedditChainForm = Devvit.createForm(
  (data) => ({
    title: "Annotate Comment",
    description:
      "Leave a classification blank to omit it (must be at the beginning)",
    acceptLabel: "Submit",
    fields: [
      ...data.commentChain.map((msg: RedditComment, idx: number) => ({
        type: "group",
        label: `u/${msg.username}: ${msg.content}`,
        fields: [
          {
            name: `classification_${idx}`,
            type: "select",
            label: "Classification",
            options: Object.values(Classification)
              .filter(
                (c) =>
                  c !== Classification.MEGABLUNDER &&
                  c !== Classification.SUPERBRILLIANT
              )
              .map((value) => ({
                label: value,
                value,
              })),
            required: idx === data.commentChain.length - 1,
          },
        ],
      })),
      {
        name: "pm_annotation",
        label: "PM you the result?",
        helpText: "(as opposed to the bot posting it for you)",
        type: "boolean",
        defaultValue: false,
      },
    ],
  }),
  async (event, context) => {
    const { values } = event;
    const { commentId, redis, scheduler, ui, userId } = context;

    try {
      const commentChainData = await redis.hGetAll(
        `${COMMENT_CHAIN_DATA_PREFIX}${commentId}_${userId}`
      );

      const unlabeledCommentChain: RedditComment[] = JSON.parse(
          commentChainData.commentChain
        ),
        commentChain: RedditComment[] = [];
      for (let i = 0; i < unlabeledCommentChain.length; i++) {
        if (!values[`classification_${i}`]) {
          if (i > 0 && values[`classification_${i - 1}`]) {
            ui.showToast(
              "Error: Omitted messages must be at the beginning of the chain"
            );
            await redis.del(
              `${COMMENT_CHAIN_DATA_PREFIX}${commentId}_${userId}`
            );
            return;
          }
        } else
          commentChain.push({
            ...unlabeledCommentChain[i],
            classification: values[`classification_${i}`][0],
          });
      }

      const uid = `annotate_${commentId}_${userId}_${Date.now().toString()}`;

      await dispatchGitHubAction(
        context,
        uid,
        commentChain,
        "render_and_upload_reddit_chain"
      );

      const runAt = new Date(Date.now() + RENDER_INITIAL_DELAY);

      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          originalId: commentId!,
          uid,
          requestingUserId: userId!,
          pmAnnotation: values.pm_annotation,
          type: "annotate_reddit_chain",
        },
        runAt,
      });

      ui.showToast({
        text: `Submitted successfully, please check back in ~${Math.floor(
          (RENDER_INITIAL_DELAY + RENDER_POLL_DELAY) / 1000
        )}s`,
        appearance: "success",
      });
    } catch (e: any) {
      ui.showToast("An unexpected error occured");
    }

    await redis.del(`${COMMENT_CHAIN_DATA_PREFIX}${commentId}_${userId}`);
  }
);

Devvit.addMenuItem({
  label: "Annotate",
  location: "post",
  onPress: async (event, context) => {
    const { targetId } = event;
    const { redis, ui } = context;

    const postData = await redis.hGetAll(`${POST_DATA_PREFIX}${targetId}`);
    if (!postData.analysis) {
      ui.showToast("No analysis found for this post");
      return;
    }

    const analysis: Analysis = JSON.parse(postData.analysis);
    ui.showForm(annotateAnalysisForm, { analysis });
  },
});

Devvit.addMenuItem({
  label: "Annotate",
  location: "comment",
  onPress: async (event, context) => {
    const { targetId } = event;
    const { appName, redis, reddit, ui, userId } = context;

    let commentChain = [],
      nextId = targetId;

    do {
      const comment = await reddit.getCommentById(nextId);
      if (
        !comment.removed &&
        comment.authorName !== "TextingTheory-ModTeam" &&
        comment.authorName !== "AutoModerator"
      ) {
        const redditComment: RedditComment = {
          username: comment.authorName,
          content: getNormalizedCommentBody(appName, comment),
        };
        commentChain.unshift(redditComment);
      } else if (!commentChain.length) {
        ui.showToast("Error: Cannot annotate this comment");
        return;
      }
      nextId = comment.parentId;
    } while (nextId.startsWith("t1_"));

    await redis.hSet(`${COMMENT_CHAIN_DATA_PREFIX}${targetId}_${userId}`, {
      commentChain: JSON.stringify(commentChain),
    });

    ui.showForm(annotateRedditChainForm, { commentChain });
  },
});

Devvit.addMenuItem({
  label: "Force Analysis",
  location: "post",
  forUserType: "moderator",
  onPress: async (event, context) => {
    const { targetId } = event;
    const { redis, reddit, scheduler, settings, userId, ui } = context;

    const geminiApiKey: string | undefined = await settings.get(
      "GEMINI_API_KEY"
    );
    if (!geminiApiKey)
      throw new Error("GEMINI_API_KEY not set in app settings.");

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    const post = await reddit.getPostById(targetId);

    if (!post || post.removedByCategory) return;

    console.log(`[${post.id}] ${userId} forced analysis.`);

    let analysis: Analysis | undefined,
      shouldVote = false;

    const postDataKey = `${POST_DATA_PREFIX}${post.id}`;

    const postData = await redis.hGetAll(postDataKey);
    if (postData.analysis) {
      analysis = JSON.parse(postData.analysis);
      if (!analysis) return;

      if (!postData.elo_votes || postData.elo_votes === "[]") shouldVote = true;
    } else {
      const imageUrls: string[] = [];

      if (post.gallery.length) {
        console.log(
          `[${post.id}] Post content has ${post.gallery.length} items.`
        );
        for (const galleryMedia of post.gallery) {
          imageUrls.push(galleryMedia.url);
        }
      }

      analysis = await getGeminiAnalysis(
        ai,
        imageUrls,
        post.id,
        post.title,
        post.body
      );

      if (!analysis) {
        console.log(`[${post.id}] No analysis, returning`);
        return;
      }

      normalizeClassifications(analysis);

      await redis.hSet(postDataKey, {
        analysis: JSON.stringify(analysis),
      });
      console.log(`[${post.id}] Analysis stored in Redis Hash.`);

      shouldVote = true;
    }

    if (post.flair?.templateId === ALREADY_ANNOTATED_FLAIR_ID) return;

    if (shouldVote) {
      console.log(`[${post.id}] Elo vote post detected... voting`);

      if (!analysis.vote_target || !analysis.elo[analysis.vote_target])
        console.log(`[${post.id}] No valid Elo found... skipping`);
      else {
        try {
          await handleEloVote(
            context,
            post.id,
            post.title,
            post.authorId!,
            NO_ELO_USER_FLAIR_IDS[0],
            analysis.elo[analysis.vote_target]!
          );
        } catch (e: any) {
          console.error(`[${post.id}] Error handling bot vote, skipping...`, e);
        }
      }
    }

    const uid = `analysis_${post.id}`;

    await dispatchGitHubAction(context, uid, analysis!, "render_and_upload");

    ui.showToast("Dispatched successfully");

    const runAt = new Date(Date.now() + RENDER_INITIAL_DELAY);
    try {
      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          analysis: analysis!,
          similarConversations: [],
          originalId: post.id,
          uid,
          type: "analysis",
        },
        runAt,
      });
    } catch (e: any) {
      console.error("Error scheduling future comment");
    }
  },
});

Devvit.addMenuItem({
  label: "Delete Saved Analysis",
  location: "post",
  forUserType: "moderator",
  onPress: async (event, context) => {
    const { targetId } = event;
    const { redis, reddit, userId, ui } = context;

    const post = await reddit.getPostById(targetId);

    const postDataKey = `${POST_DATA_PREFIX}${post.id}`;

    await redis.hDel(postDataKey, ["analysis"]);

    console.log(`[${post.id}] ${userId} deleted saved analysis.`);
    ui.showToast("Deleted successfully");
  },
});

Devvit.addSchedulerJob({
  name: "comment_analysis",
  onRun: async (event, context) => {
    const {
      analysis,
      attempt,
      similarConversations,
      originalId,
      uid,
      type,
      requestingUserId,
      pmAnnotation,
    } = event.data!;
    const { media, reddit, redis, scheduler, subredditName, appName } = context;

    const baseUrl = "https://cdn.allthepics.net/images";
    const datePath = formatDateAsPath(new Date());
    const filename = `${uid}.png`;
    const imageUrl = `${baseUrl}/${datePath}/${filename}`;

    let uploadResponse;

    try {
      console.log(`[${uid}] Attempting to ingest image from: ${imageUrl}`);
      uploadResponse = await media.upload({
        url: imageUrl,
        type: "image",
      });
    } catch (e: any) {
      console.error(`[${uid}] Error uploading render`);

      const curAttempt = Number(attempt ?? 1);

      if (curAttempt >= MAX_RENDER_POLL_ATTEMPTS) {
        console.log(`Max poll attempts reached, stopping...`);
        return;
      }

      console.log(`Retrying after wait...`);

      const runAt = new Date(Date.now() + RENDER_POLL_DELAY);
      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          analysis,
          similarConversations,
          attempt: curAttempt + 1,
          originalId,
          uid,
          type,
          requestingUserId,
          pmAnnotation,
        },
        runAt,
      });
      return;
    }

    if (type === "analysis") {
      let post;

      try {
        post = await reddit.getPostById(originalId as string);
        if (post.removedByCategory) {
          console.log(`[${originalId}] Post is removed, aborting.`);
          return;
        }
        const postComments = await reddit
          .getComments({ postId: originalId as string })
          .all();
        for (const postComment of postComments) {
          if (
            postComment.authorName === appName &&
            !postComment.removed &&
            !ANNOTATION_REGEX.test(postComment.body)
          ) {
            console.log(
              `[${originalId}] Already posted a comment to this post, aborting.`
            );
            return;
          }
        }

        const reviewAnalysis = analysis as Analysis;
        const reviewSimilarConversations =
          similarConversations as PineconeMatch[];

        for (const similarConversation of reviewSimilarConversations) {
          const similarConversationPost = await reddit.getPostById(
            similarConversation.id
          );
          similarConversation.title = similarConversationPost.title;
        }

        if (
          TITLE_ME_VOTE_REGEX.test(post.title) &&
          reviewAnalysis.vote_target &&
          reviewAnalysis.color[reviewAnalysis.vote_target]
        )
          reviewAnalysis.color[
            reviewAnalysis.vote_target
          ]!.label = `u/${post.authorName}`;

        const richTextComment = buildReviewComment(
          reviewAnalysis,
          uploadResponse.mediaId,
          reviewSimilarConversations
        );

        const comment = await reddit.submitComment({
          id: originalId as string,
          richtext: richTextComment,
        });
        await comment.distinguish(true);

        console.log(`✅ [${uid}] Successfully posted analysis comment.`);

        const newCount = await redis.incrBy(ANALYSIS_COUNT_KEY, 1);

        const flairText = `:textfish:Textfish | ${Intl.NumberFormat(
          "en-US"
        ).format(newCount)} Games Analyzed`;
        await reddit.setUserFlair({
          subredditName: subredditName!,
          username: appName,
          text: flairText,
          flairTemplateId: TEXTFISH_FLAIR_TEMPLATE_ID,
        });

        console.log(`[${uid}] Bot flair updated to "${flairText}".`);
      } catch (e: any) {
        console.error(
          `[${uid}] Error commenting analysis: ${e.message}`,
          e.stack
        );
      }
    } else if (type === "annotate") {
      try {
        const requestingUsername = (await reddit.getUserById(
          requestingUserId as string
        ))!.username;

        if (pmAnnotation) {
          const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${originalId}/`;
          await reddit.sendPrivateMessage({
            subject: `Your annotation on a post from r/${subredditName}`,
            text: `Here's the [annotation](${uploadResponse.mediaUrl}) you requested from [this post](${postUrl}). You can save it to your device and add it as a reply!`,
            to: requestingUsername,
          });
        } else {
          const richTextComment = buildAnnotateComment(
            requestingUsername,
            uploadResponse.mediaId
          );

          const comment = await reddit.submitComment({
            id: originalId as string,
            richtext: richTextComment,
          });
          await comment.distinguish();
        }
      } catch (e: any) {
        console.error(
          `[${uid}] Error commenting/sending annotation: ${e.message}`,
          e.stack
        );
      }
    } else if (type === "annotate_reddit_chain") {
      try {
        const commentUrl = (await reddit.getCommentById(originalId as string))
          .url;

        const requestingUsername = (await reddit.getUserById(
          requestingUserId as string
        ))!.username;

        if (pmAnnotation) {
          await reddit.sendPrivateMessage({
            subject: `Your annotation on a Reddit comment(s) from r/${subredditName}`,
            text: `Here's the [annotation](${uploadResponse.mediaUrl}) you requested from [this comment](${commentUrl}). You can save it to your device and add it as a reply!`,
            to: requestingUsername,
          });
        } else {
          const richTextComment = buildAnnotateComment(
            requestingUsername,
            uploadResponse.mediaId
          );

          const comment = await reddit.submitComment({
            id: originalId as string,
            richtext: richTextComment,
          });
          await comment.distinguish(true);
        }
      } catch (e: any) {
        console.error(
          `[${uid}] Error commenting/sending reddit chain annotation: ${e.message}`,
          e.stack
        );
      }
    }
  },
});

Devvit.addTrigger({
  event: "PostCreate",
  onEvent: async (event, context) => {
    const { post, subreddit } = event;
    const { redis, reddit, scheduler, settings, subredditName } = context;

    if (!post || post.deleted) return;

    console.log(`[${post.id}] New post in r/${subreddit?.name}.`);

    const geminiApiKey: string | undefined = await settings.get(
      "GEMINI_API_KEY"
    );
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY not set in app settings.");
      return;
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    const pineconeApiKey: string | undefined = await settings.get(
      "PINECONE_API_KEY"
    );
    if (!pineconeApiKey) {
      console.error("PINECONE_API_KEY not set in app settings.");
      return;
    }

    const pc = new Pinecone({
      apiKey: pineconeApiKey,
    });

    const pineconeIndex = pc.Index("texting-theory");

    const dayOfWeek = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    });

    if (
      post.linkFlair &&
      NO_ANALYSIS_FLAIR_IDS.includes(post.linkFlair.templateId)
    )
      return;

    const postDataKey = `${POST_DATA_PREFIX}${post.id}`;
    const isVotePost = true;

    const newField = await redis.hSetNX(postDataKey, "elo_votes", "[]");

    if (!newField) {
      console.log(
        `[${post.id}] Post is already being processed or complete. Skipping.`
      );
      return;
    }

    console.log(
      `[${post.id}] Acquired lock via 'elo_votes' and initialized with empty votes.`
    );

    if (
      (post.linkFlair?.templateId === MEGABLUNDER_MONDAY_FLAIR_ID &&
        dayOfWeek !== "Monday") ||
      (post.linkFlair?.templateId === SUPERBRILLIANT_SATURDAY_FLAIR_ID &&
        dayOfWeek !== "Saturday")
    )
      await reddit.setPostFlair({
        subredditName: subredditName!,
        postId: post.id,
        flairTemplateId: REQUESTING_ANNOTATION_FLAIR_ID,
      });

    const imageUrls: string[] = [];

    if (post.crosspostParentId) {
      console.log(
        `[${post.id}] Post is a crosspost. Fetching original post ${post.crosspostParentId}...`
      );
      let sourcePost;
      try {
        sourcePost = await reddit.getPostById(post.crosspostParentId);
      } catch (error) {
        console.error(
          `[${post.id}] Failed to fetch crosspost parent ${post.crosspostParentId}: ${error}`
        );
        return;
      }

      for (const galleryMedia of sourcePost.gallery) {
        imageUrls.push(galleryMedia.url);
      }
    } else {
      if (post.isGallery) {
        console.log(
          `[${post.id}] Post content is a gallery with ${post.galleryImages.length} items.`
        );
        for (const url of post.galleryImages) {
          imageUrls.push(url);
        }
      } else if (post.isImage && post.url) {
        console.log(`[${post.id}] Post content is a single image.`);
        imageUrls.push(post.url);
      }
    }

    const analysis = await getGeminiAnalysis(
      ai,
      imageUrls,
      post.id,
      post.title,
      post.selftext
    );

    if (!analysis) return;

    normalizeClassifications(analysis);

    await redis.hSet(postDataKey, {
      analysis: JSON.stringify(analysis),
    });
    console.log(`[${post.id}] Analysis stored in Redis Hash.`);

    if (post.linkFlair?.templateId === ALREADY_ANNOTATED_FLAIR_ID) return;

    if (isVotePost) {
      console.log(`[${post.id}] Elo vote post detected... voting`);

      if (!analysis.vote_target || !analysis.elo[analysis.vote_target])
        console.log(`[${post.id}] No valid Elo found... skipping`);
      else {
        try {
          await handleEloVote(
            context,
            post.id,
            post.title,
            post.authorId,
            post.authorFlair?.templateId,
            analysis.elo[analysis.vote_target]!
          );
        } catch (e: any) {
          console.error(`[${post.id}] Error handling bot vote, skipping...`, e);
        }
      }
    }

    let similarConversations: PineconeMatch[] = [];

    try {
      const convoText = getConvoText(analysis.messages);
      const embedding = await getEmbedding(ai, convoText);

      similarConversations = await findSimilarConversations(
        pineconeIndex,
        embedding
      );

      await pineconeIndex.upsert([
        { id: post.id, values: embedding, metadata: { convoText } },
      ]);
    } catch (e: any) {
      console.error("Error with embedding/Pinecone", e);
    }

    const uid = `analysis_${post.id}`;

    await dispatchGitHubAction(context, uid, analysis, "render_and_upload");

    const runAt = new Date(Date.now() + RENDER_INITIAL_DELAY);
    try {
      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          analysis,
          similarConversations,
          originalId: post.id,
          uid,
          type: "analysis",
        },
        runAt,
      });
    } catch (e: any) {
      console.error("Error scheduling future comment");
    }
  },
});

Devvit.addTrigger({
  event: "PostDelete",
  onEvent: async (event, context) => {
    const { postId } = event;
    const { appName, redis, reddit, settings } = context;

    const pineconeApiKey: string | undefined = await settings.get(
      "PINECONE_API_KEY"
    );
    if (!pineconeApiKey)
      throw new Error("PINECONE_API_KEY not set in app settings.");

    const pc = new Pinecone({
      apiKey: pineconeApiKey,
    });
    const pineconeIndex = pc.Index("texting-theory");

    try {
      const post = await reddit.getPostById(postId);
      if (!post.removedByCategory) return;
    } catch (e: any) {
      console.log("Couldnt find deleted post");
    }

    console.log(`[${postId}] Post deleted.`);

    try {
      const comments = await reddit.getComments({ postId }).all();
      for (const comment of comments) {
        if (comment.authorName === appName) {
          try {
            await comment.delete();
            console.log(`[${postId}] Bot comment(s) deleted successfully.`);
          } catch (e: any) {
            console.error(
              `[${postId}] Failed to delete bot comment ${comment.id}:`,
              e
            );
          }
        }
      }
    } catch (e: any) {
      console.error(`[${postId}] Error fetching comments for deletion:`, e);
    }

    try {
      await redis.del(`${POST_DATA_PREFIX}${postId}`);
      await redis.del(`${VOTERS_PREFIX}${postId}`);
      await redis.zRem(LEADERBOARD_KEY, [postId]);
      console.log(`[${postId}] Redis cleared successfully.`);
    } catch (e: any) {
      console.error(`[${postId}] Error cleaning up Redis:`, e);
    }

    try {
      await pineconeIndex.deleteOne(postId);
      console.log(`[${postId}] Pinecone entry deleted successfully.`);
    } catch (e: any) {
      console.error(`[${postId}] Error deleting Pinecone entry:`, e);
    }
  },
});

Devvit.addTrigger({
  event: "CommentCreate",
  onEvent: async (event, context) => {
    const { post, comment, author } = event;
    const { reddit } = context;

    if (!post || !comment || !author) return;

    const eloVoteMatch = comment.body.match(ELO_VOTE_REGEX);
    if (!eloVoteMatch) return;

    const voteValue = parseInt(eloVoteMatch[1], 10);

    if (badVoteValue(voteValue)) {
      await reddit.remove(comment.id, false);
      return;
    }

    await handleUserEloVote(context, post, author, voteValue);
  },
});

// Devvit.addTrigger({
//   event: "CommentUpdate",
//   onEvent: async (event, context) => {
//     const { post, comment, previousBody, author } = event;
//     const { reddit } = context;

//     if (!post || !comment || !author) return;

//     const eloVoteMatch = comment.body.match(ELO_VOTE_REGEX);
//     if (!eloVoteMatch) return;
//     const voteValue = parseInt(eloVoteMatch[1], 10);

//     if (
//       comment.spam &&
//       !ELO_VOTE_REGEX.test(previousBody) &&
//       eloVoteMatch
//       // && comment.parentId.startsWith("t1_")
//     ) {
//       const postComment = await reddit.getCommentById(comment.id);
//       for await (const reply of postComment.replies) {
//         if (
//           reply.authorName === "AutoModerator" &&
//           reply.body.includes("`!elo <number>`")
//         ) {
//           await reply.remove();
//           break;
//         }
//       }

//       if (badVoteValue(voteValue))
//         return;

//       await reddit.approve(comment.id);

//       await handleUserEloVote(context, post, author, voteValue);
//     }
//   },
// });

function badVoteValue(voteValue: number): boolean {
  return BANNED_VOTE_VALUES.includes(voteValue);
}

function calculateConsensusElo(votes: number[]): number {
  const voteCount = votes.length;
  if (voteCount === 0) {
    throw new Error("No votes provided to calculate Elo.");
  }

  // Base Case: If there is only one vote, there's nothing to average.
  if (voteCount === 1) return votes[0];

  const sortedVotes = [...votes].sort((a, b) => a - b);

  // For all cases with 2 or more votes, use Interquartile Mean (IQM).
  const trimProportion = 0.25;
  const trimAmount = voteCount * trimProportion;

  // The number of full elements to discard from each end.
  const k = Math.floor(trimAmount);
  // The fractional part, used for weighting the boundary elements.
  const g = trimAmount - k;

  // Sum the core values which are guaranteed to be fully included.
  const coreSlice = sortedVotes.slice(k + 1, voteCount - (k + 1));
  let weightedSum = coreSlice.reduce((acc, vote) => acc + vote, 0);

  // Add the partially-weighted boundary values.
  const boundaryWeight = 1 - g;
  weightedSum += sortedVotes[k] * boundaryWeight;
  weightedSum += sortedVotes[voteCount - 1 - k] * boundaryWeight;

  // The denominator is the total number of "effective" votes after trimming.
  const totalWeight = voteCount - 2 * trimAmount;

  const consensusAverage = weightedSum / totalWeight;

  return Math.round(consensusAverage);
}

function getTitleEmoji(elo: number): string {
  if (elo >= 2500) return ":gm:";
  if (elo >= 2400) return ":im:";
  if (elo >= 2300) return ":fm:";
  if (elo >= 2200) return ":cm:";
  return "";
}

async function handleEloVote(
  context: TriggerContext,
  postId: string,
  postTitle: string,
  postAuthorId: string,
  postAuthorFlairTemplateId: string | undefined,
  vote: number
): Promise<void> {
  const { redis, reddit, subredditName } = context;

  const clampedVote = Math.max(MIN_VOTE_VALUE, Math.min(MAX_VOTE_VALUE, vote));

  const postDataKey = `${POST_DATA_PREFIX}${postId}`;
  const postData = await redis.hGetAll(postDataKey);

  // Get all previous votes and add the new one
  const eloVotes: number[] = JSON.parse(postData.elo_votes || "[]");
  const curElo = eloVotes.length ? calculateConsensusElo(eloVotes) : undefined;

  eloVotes.push(clampedVote);

  const newElo = calculateConsensusElo(eloVotes);
  const newVoteCount = eloVotes.length;

  await redis.hSet(postDataKey, {
    elo_votes: JSON.stringify(eloVotes),
  });

  console.log(
    `[${postId}] Vote: ${clampedVote}. Recalculated Elo from ${newVoteCount} votes is now: ${newElo}`
  );

  await redis.zAdd(LEADERBOARD_KEY, {
    score: newElo,
    member: postId,
  });

  if (newVoteCount >= MIN_VOTES_FOR_POST_FLAIR) {
    const flairText = `${newElo} Elo (${newVoteCount} ${
      newVoteCount === 1 ? "vote" : "votes"
    })`;
    const newEloColor = getEloColor(newElo);
    try {
      const postFlairOptions: SetPostFlairOptions = {
        subredditName: subredditName!,
        postId: postId,
        text: flairText,
        textColor: "light",
      };
      if (newVoteCount >= MIN_VOTES_FOR_USER_FLAIR)
        postFlairOptions.backgroundColor = newEloColor;

      await reddit.setPostFlair(postFlairOptions);

      console.log(`[${postId}] Flair updated to "${flairText}"`);

      if (
        !TITLE_ME_VOTE_REGEX.test(postTitle) ||
        newVoteCount < MIN_VOTES_FOR_USER_FLAIR ||
        (postAuthorFlairTemplateId &&
          NO_ELO_USER_FLAIR_IDS.includes(postAuthorFlairTemplateId))
      )
        return;

      const postAuthor = (await reddit.getUserById(postAuthorId))!;
      const postAuthorFlair = await postAuthor.getUserFlairBySubreddit(
        subredditName!
      );

      let curUserElo: number | undefined;
      const eloUserFlairMatch = postAuthorFlair?.flairText?.match(ELO_REGEX);
      if (eloUserFlairMatch) curUserElo = parseInt(eloUserFlairMatch[1], 10);

      if (!curUserElo && newVoteCount !== MIN_VOTES_FOR_USER_FLAIR) return;

      if (!curUserElo || curElo === curUserElo || newElo > curUserElo) {
        const postAuthorFlairText = `${getTitleEmoji(newElo)}${newElo} Elo`;

        await reddit.setUserFlair({
          subredditName: subredditName!,
          username: postAuthor.username,
          text: postAuthorFlairText,
          backgroundColor: newEloColor,
          textColor: "light",
        });

        console.log(
          `[${postId}] User flair updated to "${postAuthorFlairText}"`
        );

        if (!curUserElo) {
          const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${postId}/`;
          await reddit.sendPrivateMessage({
            subject: `Your user flair on r/${subredditName} has been updated`,
            text: `Your [post](${postUrl}) on r/${subredditName} reached ${MIN_VOTES_FOR_USER_FLAIR} Elo votes with a consensus of ${newElo} Elo. Your user flair has been automatically updated, and will continue to be updated as long as you don't remove it. You can [remove it on the subreddit](https://www.reddit.com/r/TextingTheory/comments/14jo7nq/user_flairs_just_dropped/), or choose to wear it like a badge of honor, even if it's low.`,
            to: postAuthor.username,
          });

          console.log("PM sent to user");
        }
      }
    } catch (e: any) {
      console.error(`[${postId}] Failed to set flair:`, e);
    }
  }
}

async function handleUserEloVote(
  context: TriggerContext,
  post: PostV2,
  author: UserV2,
  voteValue: number
) {
  if (
    post.linkFlair &&
    (NO_ANALYSIS_FLAIR_IDS.includes(post.linkFlair.templateId) ||
      post.linkFlair.templateId === ALREADY_ANNOTATED_FLAIR_ID)
  )
    return;

  const { reddit, redis } = context;

  const votersKey = `${VOTERS_PREFIX}${post.id}`;

  const authorAccountCreatedAt = (await reddit.getUserById(author.id))!
    .createdAt;

  if (
    author.id !== post.authorId &&
    author.karma >= MIN_KARMA_TO_VOTE &&
    Date.now() - authorAccountCreatedAt.getTime() >= MIN_AGE_TO_VOTE_MS &&
    (await redis.hSetNX(votersKey, author.id, "1"))
  )
    await handleEloVote(
      context,
      post.id,
      post.title,
      post.authorId,
      post.authorFlair?.templateId,
      voteValue
    );
}

function getClassificationAccuracy(
  classification: CountedClassification
): number {
  const { accuracy, radius } = CLASSIFICATION_ACCURACY_INFO[classification];
  const jitter = (Math.random() * 2 - 1) * radius;
  return Math.min(100, accuracy + jitter);
}

function getAccuracyString(
  messages: Message[],
  side: "left" | "right"
): string {
  let totalScore = 0;
  let classifiedMovesCount = 0;

  const playerMessages = messages.filter((message) => message.side === side);

  for (const message of playerMessages) {
    if (message.classification in CLASSIFICATION_ACCURACY_INFO) {
      totalScore += getClassificationAccuracy(
        message.classification as CountedClassification
      );
      classifiedMovesCount++;
    }
  }

  if (classifiedMovesCount === 0) return "N/A";

  const averageAccuracy = totalScore / classifiedMovesCount;

  const clampedAccuracy = Math.min(100, Math.max(0, averageAccuracy));

  return clampedAccuracy.toFixed(1);
}

function buildReviewComment(
  analysis: Analysis,
  mediaId: string,
  similarConversations: PineconeMatch[]
): RichTextBuilder {
  const counts: Record<CountedClassification, { left: number; right: number }> =
    {
      [Classification.SUPERBRILLIANT]: { left: 0, right: 0 },
      [Classification.BRILLIANT]: { left: 0, right: 0 },
      [Classification.GREAT]: { left: 0, right: 0 },
      [Classification.BEST]: { left: 0, right: 0 },
      [Classification.MISTAKE]: { left: 0, right: 0 },
      [Classification.MISS]: { left: 0, right: 0 },
      [Classification.BLUNDER]: { left: 0, right: 0 },
      [Classification.MEGABLUNDER]: { left: 0, right: 0 },
    };
  let hasLeft = false,
    hasRight = false;
  analysis.messages.forEach((msg: Message) => {
    if (msg.side === "left" && !IMPLIED_MESSAGE_REGEX.test(msg.content))
      hasLeft = true;
    else if (msg.side === "right" && !IMPLIED_MESSAGE_REGEX.test(msg.content))
      hasRight = true;

    if (msg.classification in counts)
      counts[msg.classification as CountedClassification][msg.side]++;
  });

  let builder = new RichTextBuilder()
    .paragraph((p) =>
      p.text({
        text: "✪ Game Review",
        formatting: [[1, 0, 13]],
      })
    )
    .paragraph((p) => p.text({ text: analysis.comment }))
    .image({ mediaId })
    .paragraph((p) =>
      p.text({
        text: analysis.opening_name,
        formatting: [[2, 0, analysis.opening_name.length]],
      })
    )
    .table((table) => {
      table.headerCell({ columnAlignment: "left" }, () => {});
      if (hasLeft)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.left!.label +
              (analysis.vote_target === "left" ? " [Vote]" : ""),
          })
        );
      if (hasRight)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.right!.label +
              (analysis.vote_target === "right" ? " [Vote]" : ""),
          })
        );

      table.row((row) => {
        row.cell((cell) => cell.text({ text: "Accuracy" }));
        if (hasLeft)
          row.cell((cell) =>
            cell.text({
              text: `\`${getAccuracyString(analysis.messages, "left")}\``,
            })
          );
        if (hasRight)
          row.cell((cell) =>
            cell.text({
              text: `\`${getAccuracyString(analysis.messages, "right")}\``,
            })
          );
      });

      table.row((row) => {
        row.cell(() => {});
        if (hasLeft) row.cell(() => {});
        if (hasRight) row.cell(() => {});
      });

      Object.entries(counts).forEach(([key, value]) => {
        if (
          (key == Classification.SUPERBRILLIANT ||
            key == Classification.MEGABLUNDER) &&
          value.left == 0 &&
          value.right == 0
        )
          return;

        const classificationUnicode =
          CLASSIFICATION_UNICODES[key as CountedClassification];

        table.row((row) => {
          row.cell((cell) =>
            cell.text({
              text: `${key} (${classificationUnicode})`,
              formatting: [[1, key.length + 2, classificationUnicode.length]],
            })
          );
          if (hasLeft)
            row.cell((cell) => cell.text({ text: value.left.toString() }));
          if (hasRight)
            row.cell((cell) => cell.text({ text: value.right.toString() }));
        });
      });

      table.row((row) => {
        row.cell(() => {});
        if (hasLeft) row.cell(() => {});
        if (hasRight) row.cell(() => {});
      });

      table.row((row) => {
        row.cell((cell) => cell.text({ text: "Game Rating" }));
        if (hasLeft)
          row.cell((cell) =>
            cell.text({
              text: `\`${analysis.elo.left!}\``,
            })
          );
        if (hasRight)
          row.cell((cell) =>
            cell.text({
              text: `\`${analysis.elo.right!}\``,
            })
          );
      });
    });

  if (similarConversations.length) {
    builder = builder
      .paragraph((paragraph) => paragraph.text({ text: "Similar Games:" }))
      .list({ ordered: true }, (list) => {
        similarConversations.forEach((match) =>
          list.item((item) =>
            item.paragraph((paragraph) =>
              paragraph
                .postLink({
                  permalink: `/r/TextingTheory/comments/${match.id}`,
                })
                .text({ text: ` (${(match.score * 100).toFixed(1)}%)` })
            )
          )
        );
      });
  }

  builder = builder.paragraph((p) =>
    p
      .text({
        text: "This bot is for entertainment purposes only. ",
        formatting: [[32, 0, 45]],
      })
      .link({
        text: "about the bot",
        formatting: [[32, 0, 13]],
        url: ABOUT_THE_BOT_LINK,
      })
      .text({
        text: " | ",
        formatting: [[32, 0, 3]],
      })
      .link({
        text: "symbols meaning?",
        formatting: [[32, 0, 16]],
        url: ICON_MEANINGS_LINK,
      })
      .text({
        text: " | ",
        formatting: [[32, 0, 3]],
      })
      .link({
        text: "what is Elo?",
        formatting: [[32, 0, 13]],
        url: WHAT_IS_ELO_LINK,
      })
      .text({
        text: " | ",
        formatting: [[32, 0, 3]],
      })
      .link({
        text: "Annotate menu",
        formatting: [[32, 0, 13]],
        url: MORE_ANNOTATION_INFO_LINK,
      })
  );

  return builder;
}

Devvit.addMenuItem({
  label: "Test Status Update",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (event, context) => {
    const { ui, subredditId } = context;

    // The GraphQL endpoint URL.
    const GRAPHQL_URL = "https://www.reddit.com/svc/shreddit/graphql";

    // Define the rich text content for the status widget.
    const richTextPayload = {
      document: [
        {
          e: "par",
          c: [{ e: "text", t: "Megablunder Test", f: [[1, 0, 15]] }], // Bold text
        },
        {
          e: "par",
          c: [
            { e: "u/", t: "textingtheorybot", l: false },
            { e: "text", t: " status is in test mode.", f: [] },
          ],
        },
      ],
    };

    // Construct the full GraphQL payload.
    const fullPayload = {
      operation: "UpdateCommunityStatus",
      variables: {
        input: {
          subredditId: subredditId,
          emojiId: "megablunder", // The name of your custom emoji
          description: { richText: JSON.stringify(richTextPayload) },
        },
      },
    };

    try {
      console.log(
        "Sending payload to set subreddit status:",
        JSON.stringify(fullPayload, null, 2)
      );

      // Use the global `fetch` function. Devvit handles authentication for reddit.com URLs.
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fullPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `API call failed with status ${response.status}: ${errorText}`
        );
      }

      const responseData = await response.json();
      console.log("Successfully updated subreddit status:", responseData);

      ui.showToast({
        text: "Successfully set the subreddit status!",
        appearance: "success",
      });
    } catch (error) {
      console.error("Failed to set subreddit status:", error);
    }
  },
});

function buildAnnotateComment(
  requestingUsername: string,
  mediaId: string
): RichTextBuilder {
  return new RichTextBuilder()
    .image({ mediaId })
    .paragraph((p) => p.text({ text: `Annotated by u/${requestingUsername}` }))
    .paragraph((p) =>
      p.link({
        text: "make your own",
        formatting: [[32, 0, 13]],
        url: MORE_ANNOTATION_INFO_LINK,
      })
    );
}

export default Devvit;
