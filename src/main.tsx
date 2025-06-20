import {
  Devvit,
  TriggerContext,
  SettingScope,
  RichTextBuilder,
  Context,
  Comment,
} from "@devvit/public-api";
import { PostV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/postv2.js";
import {
  createPartFromBase64,
  GoogleGenAI,
  createUserContent,
  HarmCategory,
  HarmBlockThreshold,
  Type,
} from "@google/genai";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  Analysis,
  Classification,
  CountedClassification,
  Message,
  RedditComment,
} from "./analysis.js";
import { getEloColor } from "./color.js";

const MIN_VOTE_VALUE = 100;
const MAX_VOTE_VALUE = 3000;
const ELO_VOTE_TOLERANCE = 300;
const MIN_VOTES_FOR_FLAIR = 1;
const MIN_KARMA_TO_VOTE = 25;
const MIN_AGE_TO_VOTE_MS = 7 * 24 * 60 * 60 * 1000;

const TITLE_BRACKETS_REGEX = /^\[\S(.*\S)?\]/i;
const TITLE_NO_VOTE_REGEX = /^\[no vote\]/i;
const VOTE_COMMAND_REGEX = /!elo\s+(-?\d+)\b/i;

const REQUESTING_ANNOTATION_FLAIR_ID = "a79dfdbc-4b09-11f0-a6f6-e2bae3f86d0a",
  ALREADY_ANNOTATED_FLAIR_ID = "c2d007e7-ca1c-11eb-bc34-0e56c289897d",
  MEGABLUNDER_MONDAY_FLAIR_ID = "a41e2978-4c76-11f0-a7d9-8a051a625ee6",
  SUPERBRILLIANT_SATURDAY_FLAIR_ID = "b4df51ec-4c76-11f0-8011-568335338cf7",
  META_FLAIR_ID = "edde53c6-7cb1-11ee-8104-3e49ebced071",
  ANNOUNCEMENT_FLAIR_ID = "dd6d2d40-ca1c-11eb-8d7e-0ec8e8045baf";
const NO_ANALYSIS_FLAIR_IDS = [META_FLAIR_ID, ANNOUNCEMENT_FLAIR_ID];

const POST_DATA_PREFIX = "post_data:";
const COMMENT_CHAIN_DATA_PREFIX = "comment_chain:";
const VOTERS_PREFIX = "voters:";
const LEADERBOARD_KEY = "elo_leaderboard";

const RENDER_INITIAL_DELAY = 15000;
const RENDER_POLL_DELAY = 5000;
const MAX_RENDER_POLL_ATTEMPTS = 5;

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
]);

function getGeminiConfig() {
  const dayOfWeek = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  });
  const validClassifications = Object.values(Classification).filter(
    (c) =>
      (c !== Classification.SUPERBRILLIANT &&
        c !== Classification.MEGABLUNDER) ||
      (c === Classification.SUPERBRILLIANT && dayOfWeek === "Saturday") ||
      (c === Classification.MEGABLUNDER && dayOfWeek === "Monday")
  );

  const SUPERBRILLIANT_TEXT = `\`Superbrilliant\` (0.1% rarity) An absolutely god-like find, perfection. Someone can try for years and never get a classification this good. (Only available because today is Saturday).`;
  const MEGABLUNDER_TEXT = `\`Megablunder\` (5% rarity) No coming back from this. The worst of the worst. (Only available because today is Monday).`;

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
            unsent: { type: Type.BOOLEAN, nullable: true },
          },
          required: ["side", "content", "classification"],
        },
      },
      elo: {
        type: Type.OBJECT,
        description: "Estimated Elo ratings for the players.",
        nullable: true, // The whole elo block is optional
        properties: {
          left: {
            type: Type.NUMBER,
            description: `Estimated Elo (integer) for the "left" player.`,
            nullable: true,
          },
          right: {
            type: Type.NUMBER,
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
        description: "A creative opening name for the conversation.",
      },
      commentary: {
        type: Type.STRING,
        description: "A one-sentence commentary on the game or conversation.",
      },
      not_analyzable: {
        type: Type.BOOLEAN,
        description:
          "true only if the input image(s) are not a conversation. Omit otherwise.",
        nullable: true,
      },
      vote_target: {
        type: Type.STRING,
        enum: ["left", "right"],
        description:
          "If the Reddit post title brackets indicates a vote is being requested for one player (e.g., '[Blue]'), which side ('left' or 'right') you think the vote is for. Omit if no vote is requested in the title.",
        nullable: true,
      },
    },
    required: ["messages", "color", "opening_name", "commentary"],
  };

  return {
    systemInstruction: finalSystemPrompt,
    responseSchema: responseSchema,
  };
}

function formatDateAsPath(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const formatter = new Intl.DateTimeFormat("en-CA", options);
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
    ) {
      msg.classification = Classification.GOOD;
    }
    if (
      isFinalizing(msg.classification) &&
      (i < messages.length - 2 ||
        (i === messages.length - 2 &&
          !(
            next.classification === Classification.WINNER &&
            next.side !== msg.side
          )))
    ) {
      msg.classification = Classification.GOOD;
    }
    if (
      msg.classification === Classification.WINNER &&
      (i < messages.length - 1 ||
        !(prev && prev.side !== msg.side && isFinalizing(prev.classification)))
    ) {
      msg.classification = Classification.GOOD;
    }
    if (
      msg.classification === Classification.DRAW &&
      (i < messages.length - 2 ||
        (i === messages.length - 2 &&
          !(
            next.classification === Classification.DRAW &&
            next.side !== msg.side
          )))
    ) {
      msg.classification = Classification.GOOD;
    }
  }
}

function getNormalizedCommentBody(context: Context, comment: Comment): string {
  const { appName } = context;

  if (comment.authorName === appName)
    return comment.body.startsWith("Annotation")
      ? "[Custom Annotation]"
      : "[Game Review]";

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

  const dispatchUrl = `https://api.github.com/repos/pjpuzzler/textingtheory-renderer/actions/workflows/render-and-upload.yml/dispatches`;
  const dispatchResponse = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { uid, render_payload: JSON.stringify(renderData), command },
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
    title: "Annotate",
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
          },
          {
            name: `classification_${idx}`,
            type: "select",
            label: "Classification",
            options: Object.values(Classification).map((value) => ({
              label: value,
              value,
            })),
            defaultValue: [msg.classification],
          },
        ],
      })),
      {
        name: "pm_annotation",
        label: "PM you the result (as opposed to the bot posting it)?",
        type: "boolean",
        defaultValue: true,
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
        text: `Submitted successfully, if no result by ~${Math.floor(
          (RENDER_INITIAL_DELAY + RENDER_POLL_DELAY) / 1000
        )}s, please resubmit.`,
        appearance: "success",
      });
    } catch (e: any) {
      ui.showToast("An unexpected error occured.");
    }
  }
);

const annotateRedditChainForm = Devvit.createForm(
  (data) => ({
    title: "Annotate",
    description:
      "Leave classification blank to omit message(s) (must be at the beginning)",
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
            options: Object.values(Classification).map((value) => ({
              label: value,
              value,
            })),
          },
        ],
      })),
      {
        name: "pm_annotation",
        label: "PM you the result (as opposed to the bot posting it)?",
        type: "boolean",
        defaultValue: true,
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
              "Error: Omitted messages must be at the beginning of the chain."
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
        text: `Submitted successfully, if no result by ~${Math.floor(
          (RENDER_INITIAL_DELAY + RENDER_POLL_DELAY) / 1000
        )}s, please resubmit.`,
        appearance: "success",
      });
    } catch (e: any) {
      ui.showToast("An unexpected error occured.");
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
      ui.showToast("No analysis found for this post.");
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
      const redditComment: RedditComment = {
        username: comment.authorName,
        content: getNormalizedCommentBody(context, comment),
      };
      commentChain.unshift(redditComment);
      nextId = comment.parentId;
    } while (nextId.startsWith("t1_"));

    await redis.hSet(`${COMMENT_CHAIN_DATA_PREFIX}${targetId}_${userId}`, {
      commentChain: JSON.stringify(commentChain),
    });

    ui.showForm(annotateRedditChainForm, { commentChain });
  },
});

Devvit.addSchedulerJob({
  name: "comment_analysis",
  onRun: async (event, context) => {
    const {
      analysis,
      attempt,
      originalId,
      uid,
      type,
      requestingUserId,
      pmAnnotation,
    } = event.data!;
    const { media, reddit, scheduler, subredditName, appName } = context;

    const baseUrl = "https://cdn.allthepics.net/images";
    const datePath = formatDateAsPath(new Date());
    const filename = `${uid}.png`;
    const imageUrl = `${baseUrl}/${datePath}/${filename}`;

    let uploadResponse;

    try {
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
      const richTextComment = buildReviewComment(
        analysis as Analysis,
        uploadResponse.mediaId
      );

      try {
        const post = await reddit.getPostById(originalId as string);
        if (post.removedByCategory) {
          console.log(`[${originalId}] Post is removed, aborting.`);
          return;
        }
        const postComments = await reddit
          .getComments({ postId: originalId as string })
          .all();
        for (const postComment of postComments) {
          if (postComment.authorName === appName) {
            console.log(
              `[${originalId}] Already posted a comment to this post, aborting.`
            );
            return;
          }
        }

        const comment = await reddit.submitComment({
          id: originalId as string,
          richtext: richTextComment,
        });
        await comment.distinguish(true);

        console.log(`✅ [${uid}] Successfully posted analysis comment.`);
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
          await comment.distinguish();
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
    const { redis, reddit, scheduler, settings } = context;

    const apiKey: string | undefined = await settings.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not set in app settings.");

    if (!post || post.deleted) return;

    console.log(`[${post.id}] New post in r/${subreddit?.name}.`);

    const dayOfWeek = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    });

    if (
      !post.linkFlair ||
      NO_ANALYSIS_FLAIR_IDS.includes(post.linkFlair.templateId)
    )
      return;

    const postDataKey = `${POST_DATA_PREFIX}${post.id}`;
    const isVotePost =
      TITLE_BRACKETS_REGEX.test(post.title) &&
      !TITLE_NO_VOTE_REGEX.test(post.title);

    const newField = await redis.hSetNX(postDataKey, "elo_votes", `[]`);

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
      (post.linkFlair.templateId === MEGABLUNDER_MONDAY_FLAIR_ID &&
        dayOfWeek !== "Monday") ||
      (post.linkFlair.templateId === SUPERBRILLIANT_SATURDAY_FLAIR_ID &&
        dayOfWeek !== "Saturday")
    )
      await reddit.setPostFlair({
        subredditName: context.subredditName!,
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

    if (!imageUrls.length) {
      console.log(
        `[${post.id}] No processable images found in post or its source. Skipping.`
      );
      return;
    }

    console.log(
      `[${post.id}] Found ${imageUrls.length} image(s) to analyze. Fetching content...`
    );

    const geminiImageParts = [];

    try {
      const imageFetchPromises = imageUrls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
          console.error(
            `[${post.id}] Failed to fetch image at ${url}: ${response.status} ${response.statusText}`
          );
          return null;
        }
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const contentType =
          response.headers.get("content-type") || "image/jpeg";
        return createPartFromBase64(
          imageBuffer.toString("base64"),
          contentType
        );
      });

      const results = await Promise.all(imageFetchPromises);
      for (const part of results) {
        if (part) {
          geminiImageParts.push(part);
        }
      }
    } catch (error) {
      console.error(
        `[${post.id}] An error occurred while fetching images: ${error}`
      );
      return;
    }

    if (!geminiImageParts.length) {
      console.log(
        `[${post.id}] All image fetches failed or returned no data. Skipping.`
      );
      return;
    }

    const dynamicConfig = getGeminiConfig();

    const ai = new GoogleGenAI({ apiKey });

    console.log(
      `[${post.id}] Sending ${geminiImageParts.length} image(s) to Gemini with a structured schema.`
    );

    const geminiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        createUserContent([
          `Reddit Post Title: "${post.title}"\n\nReddit Post Body: "${post.selftext}"`,
          ...geminiImageParts,
        ]),
      ],
      config: {
        ...dynamicConfig,
        temperature: 0.85,
        topP: 0.95,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 24576,
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
        `[${post.id}] Gemini gave an undefined or empty response text. Skipping.`
      );
      return;
    }

    let analysis: Analysis;
    try {
      analysis = JSON.parse(geminiResponseText);
    } catch (parseError) {
      console.error(
        `[${post.id}] Failed to parse Gemini JSON response: ${parseError}`,
        geminiResponseText
      );
      return;
    }

    console.log(
      `[${post.id}] Parsed Gemini response: ${JSON.stringify(analysis)}`
    );

    if (analysis.not_analyzable) {
      console.log(
        `[${post.id}] Gemini determined this is not analyzable. Skipping.`
      );
      return;
    }

    normalizeClassifications(analysis);

    await redis.hSet(postDataKey, {
      analysis: JSON.stringify(analysis),
    });
    console.log(`[${post.id}] Analysis stored in Redis Hash.`);

    if (isVotePost) {
      console.log(`[${post.id}] Elo vote post detected... voting`);

      if (
        !analysis.elo ||
        !analysis.vote_target ||
        !analysis.elo[analysis.vote_target]
      )
        console.log(`[${post.id}] No valid Elo found... skipping`);
      else {
        try {
          await handleEloVote(
            context,
            post,
            analysis.elo[analysis.vote_target]!
          );
        } catch (e: any) {
          console.error(`[${post.id}] Error handling bot vote, skipping...`, e);
        }
      }
    }

    const uid = `analysis_${post.id}`;

    await dispatchGitHubAction(context, uid, analysis, "render_and_upload");

    const runAt = new Date(Date.now() + RENDER_INITIAL_DELAY);
    try {
      await scheduler.runJob({
        name: "comment_analysis",
        data: {
          analysis,
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
    const { appName, redis, reddit } = context;

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
  },
});

Devvit.addTrigger({
  event: "CommentCreate",
  onEvent: async (event, context) => {
    const { post, comment, author } = event;
    const { redis, reddit } = context;

    if (!post || !comment || !author || !post.linkFlair) return;

    if (
      !TITLE_BRACKETS_REGEX.test(post.title) ||
      TITLE_NO_VOTE_REGEX.test(post.title)
    )
      return;

    const match = comment.body.match(VOTE_COMMAND_REGEX);
    if (!match) return;

    const voteValue = parseInt(match[1], 10);

    if (author.id === post.authorId) {
      // const errorComment = await reddit.submitComment({
      //   id: comment.id,
      //   text: "⚠️ Sorry, the author can't vote on their own post.",
      // });
      // await errorComment.distinguish();
      return;
    }

    if (author.karma < MIN_KARMA_TO_VOTE) {
      // const errorComment = await reddit.submitComment({
      //   id: comment.id,
      //   text: `⚠️ Sorry, you need at least ${MIN_KARMA_TO_VOTE} karma to vote.`,
      // });
      // await errorComment.distinguish();
      return;
    }

    const authorAccountCreatedAt = (await reddit.getUserById(author.id))!
      .createdAt;

    if (Date.now() - authorAccountCreatedAt.getTime() < MIN_AGE_TO_VOTE_MS) {
      // const minDays = Math.ceil(MIN_AGE_TO_VOTE_MS / (1000 * 60 * 60 * 24));
      // const errorComment = await reddit.submitComment({
      //   id: comment.id,
      //   text: `⚠️ Sorry, your account must be at least ${minDays} days old to vote.`,
      // });
      // await errorComment.distinguish();
      return;
    }

    const votersKey = `${VOTERS_PREFIX}${post.id}`;
    const voteSuccessful = await redis.hSetNX(votersKey, author.id, "1");

    if (!voteSuccessful) {
      // const errorComment = await reddit.submitComment({
      //   id: comment.id,
      //   text: "⚠️ It looks like you've already voted on this post.",
      // });
      // await errorComment.distinguish();
      return;
    }

    await handleEloVote(context, post, voteValue);
  },
});

function calculateMedianEloVote(votes: number[]): number {
  if (!votes.length) {
    throw new Error("No votes provided to calculate median.");
  }
  const sorted = [...votes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function handleEloVote(
  context: TriggerContext,
  post: PostV2,
  vote: number
): Promise<void> {
  const { redis, reddit } = context;

  const clampedVote = Math.max(MIN_VOTE_VALUE, Math.min(MAX_VOTE_VALUE, vote));
  const postDataKey = `${POST_DATA_PREFIX}${post.id}`;

  const postData = await redis.hGetAll(postDataKey);

  // Get all previous votes and add the new one.
  const eloVotes: number[] = JSON.parse(postData.elo_votes);
  eloVotes.push(clampedVote);

  // Calculate the "center of gravity" using the median.
  const median = calculateMedianEloVote(eloVotes);

  // For each vote, calculate its weight based on its distance from the median.
  let totalWeightedVotes = 0;
  let totalWeight = 0;
  const toleranceSquared = ELO_VOTE_TOLERANCE * ELO_VOTE_TOLERANCE;

  for (const vote of eloVotes) {
    const distance = Math.abs(vote - median);
    const weight = Math.exp(-(distance * distance) / (2 * toleranceSquared));

    totalWeightedVotes += vote * weight;
    totalWeight += weight;
  }

  // The new Elo is the final weighted average.
  const newElo = Math.round(totalWeightedVotes / totalWeight),
    newVoteCount = eloVotes.length;

  await redis.hSet(postDataKey, {
    elo_votes: JSON.stringify(eloVotes),
  });

  console.log(
    `[${post.id}] Vote: ${clampedVote}. Recalculated Elo from ${newVoteCount} votes (using median center ${median}): ${newElo}`
  );

  await redis.zAdd(LEADERBOARD_KEY, {
    score: newElo,
    member: post.id,
  });
  console.log(`[${post.id}] Updated global leaderboard with score: ${newElo}`);

  if (newVoteCount >= MIN_VOTES_FOR_FLAIR) {
    let flairText = `${newElo} Elo`;
    try {
      await reddit.setPostFlair({
        subredditName: context.subredditName!,
        postId: post.id,
        text: flairText,
        backgroundColor: getEloColor(newElo),
        textColor: "light",
      });
      console.log(`[${post.id}] Flair updated to "${flairText}"`);
    } catch (e: any) {
      console.error(`[${post.id}] Failed to set flair:`, e);
    }
  }
}

function buildReviewComment(
  analysis: Analysis,
  mediaId: string
): RichTextBuilder {
  const counts: Record<CountedClassification, { left: number; right: number }> =
    {
      [Classification.SUPERBRILLIANT]: { left: 0, right: 0 },
      [Classification.BRILLIANT]: { left: 0, right: 0 },
      [Classification.GREAT]: { left: 0, right: 0 },
      [Classification.BEST]: { left: 0, right: 0 },
      [Classification.EXCELLENT]: { left: 0, right: 0 },
      [Classification.GOOD]: { left: 0, right: 0 },
      [Classification.BOOK]: { left: 0, right: 0 },
      [Classification.INACCURACY]: { left: 0, right: 0 },
      [Classification.MISTAKE]: { left: 0, right: 0 },
      [Classification.MISS]: { left: 0, right: 0 },
      [Classification.BLUNDER]: { left: 0, right: 0 },
      [Classification.MEGABLUNDER]: { left: 0, right: 0 },
    };
  let hasLeft = false,
    hasRight = false;
  analysis.messages.forEach((msg: Message) => {
    if (msg.side === "left") hasLeft = true;
    else if (msg.side === "right") hasRight = true;
    let effectiveClassification =
      msg.classification === Classification.FORCED
        ? Classification.GOOD
        : msg.classification;
    if (effectiveClassification in counts) {
      let countedClassification =
        effectiveClassification as CountedClassification;
      if (msg.side === "left") counts[countedClassification].left++;
      else if (msg.side === "right") counts[countedClassification].right++;
    }
  });

  const aboutBotLink = `https://www.reddit.com/r/TextingTheory/comments/1k8fed9/utextingtheorybot/`;
  return new RichTextBuilder()
    .paragraph((p) =>
      p.text({
        text: "✪ Game Review",
        formatting: [[1, 0, 13]],
      })
    )
    .paragraph((p) => p.text({ text: analysis.commentary }))
    .image({ mediaId })
    .paragraph((p) =>
      p.text({
        text: analysis.opening_name,
        formatting: [[2, 0, analysis.opening_name.length]],
      })
    )
    .table((table) => {
      if (hasLeft)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.left!.label +
              (analysis.elo?.left ? ` (${analysis.elo.left})` : ""),
          })
        );
      table.headerCell({ columnAlignment: "center" }, () => {});
      if (hasRight)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.right!.label +
              (analysis.elo?.right ? ` (${analysis.elo.right})` : ""),
          })
        );
      Object.entries(counts).forEach(([key, value]) => {
        if (
          (key == Classification.SUPERBRILLIANT ||
            key == Classification.MEGABLUNDER) &&
          value.left == 0 &&
          value.right == 0
        )
          return;
        table.row((row) => {
          if (hasLeft)
            row.cell((cell) => cell.text({ text: value.left.toString() }));
          row.cell((cell) => cell.text({ text: key }));
          if (hasRight)
            row.cell((cell) => cell.text({ text: value.right.toString() }));
        });
      });
    })
    .paragraph((p) =>
      p
        .text({
          text: "This bot is designed for comedy/entertainment only. Its reviews should not be taken seriously. ",
          formatting: [[32, 0, 97]],
        })
        .link({
          text: "about the bot",
          formatting: [[32, 0, 13]],
          url: aboutBotLink,
        })
    );
}

function buildAnnotateComment(
  requestingUsername: string,
  mediaId: string
): RichTextBuilder {
  return new RichTextBuilder()
    .paragraph((p) => p.text({ text: `Annotation by u/${requestingUsername}` }))
    .image({ mediaId });
}

export default Devvit;
