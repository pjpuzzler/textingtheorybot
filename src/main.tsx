import {
  Devvit,
  TriggerContext,
  SettingScope,
  RichTextBuilder,
} from "@devvit/public-api";
import {
  createPartFromBase64,
  GoogleGenAI,
  createUserContent,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/genai";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  Analysis,
  Classification,
  CountedClassification,
  Message,
} from "./analysis.js";

const INITIAL_ELO = 1000;
const MIN_VOTE_VALUE = 100;
const MAX_VOTE_VALUE = 3000;
const ELO_VOTE_TOLERANCE = 300;
const MIN_VOTES_FOR_FLAIR = 2;
const MIN_KARMA_TO_VOTE = 25;
const MIN_AGE_TO_VOTE_MS = 7 * 24 * 60 * 60 * 1000;

const ELO_VOTE_FLAIR_ID = "a79dfdbc-4b09-11f0-a6f6-e2bae3f86d0a";
const NO_ANALYSIS_FLAIR_IDS = [
  "c2d007e7-ca1c-11eb-bc34-0e56c289897d", // already annotated
  "edde53c6-7cb1-11ee-8104-3e49ebced071", // meta
  "dd6d2d40-ca1c-11eb-8d7e-0ec8e8045baf", // announcement
];

const POST_DATA_PREFIX = "post_data:";
const VOTERS_PREFIX = "voters:";
const LEADERBOARD_KEY = "elo_leaderboard";

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

const FILENAME_ANALYSIS_PREFIX = "render_result_analysis";
const FILENAME_ANNOTATE_PREFIX = "render_result_annotate";
const RENDER_WAIT = 30000;

let ai: GoogleGenAI | undefined;

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

async function getGemini(context: TriggerContext): Promise<GoogleGenAI> {
  const { settings } = context;

  if (!ai) {
    const apiKey = (await settings.get("GEMINI_API_KEY")) as string;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set in app settings.");
    ai = new GoogleGenAI({ apiKey });
  }

  return ai;
}

async function dispatchGitHubAction(
  context: TriggerContext,
  original_id: string,
  analysis: Analysis,
  type: string
): Promise<void> {
  const { settings } = context;

  console.log(`[${original_id}] Dispatching GitHub Action to render image...`);
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
      inputs: { original_id, render_payload: JSON.stringify(analysis), type },
    }),
  });

  if (!dispatchResponse.ok) {
    const errorText = await dispatchResponse.text();
    throw new Error(
      `Failed to dispatch GitHub Action: ${dispatchResponse.status} ${errorText}`
    );
  }
  console.log(`[${original_id}] GitHub Action dispatched successfully.`);
}

const annotateAnalysisForm = Devvit.createForm(
  (data) => ({
    title: "Annotate",
    acceptLabel: "Submit",
    fields: data.analysis.messages.map((msg: Message, idx: number) => ({
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
          options: Object.values(Classification).map((c) => ({
            label: c.charAt(0) + c.slice(1).toLowerCase(),
            value: c,
          })),
          defaultValue: [msg.classification],
        },
      ],
    })),
  }),
  async (event, context) => {
    const { values } = event;
    const { redis, reddit, scheduler, ui } = context;

    try {
      const postId = context.postId!;
      const postData = await redis.hGetAll(`${POST_DATA_PREFIX}${postId}`);

      const analysis: Analysis = JSON.parse(postData.analysis);
      for (let i = 0; i < analysis.messages.length; i++) {
        analysis.messages[i].side = values[`side_${i}`][0];
        analysis.messages[i].classification = values[`classification_${i}`][0];
      }

      const comment = await reddit.submitComment({
        id: postId,
        text: "[Requested custom annotation]",
        runAs: "USER",
      });

      await dispatchGitHubAction(context, comment.id, analysis, "annotate");

      const runAt = new Date(Date.now() + RENDER_WAIT);
      await scheduler.runJob({
        name: "comment_analysis",
        data: { analysis, originalId: comment.id, type: "annotate" },
        runAt,
      });

      ui.showToast({
        text: `Analysis requested successfully, check back in ~${Math.floor(
          RENDER_WAIT / 1000
        )}s!`,
        appearance: "success",
      });
    } catch (e: any) {
      ui.showToast("An unexpected error occured.");
    }
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
    ui.showForm(annotateAnalysisForm, { analysis, postId: targetId });
  },
});

// Devvit.addMenuItem({
//   label: "Force Analysis",
//   location: "post",
//   onPress: async (event, context) => {
//     const { targetId } = event;
//     const { reddit, ui, userId } = context;

//     if (
//       !userId ||
//       (await reddit.getUserById(userId))?.username !== "pjpuzzler"
//     ) {
//       ui.showToast("Error: not allowed");
//       return;
//     }

//     const post = await reddit.getPostById(targetId);

//     await runAnalysis(post, context);
//   },
// });

Devvit.addSchedulerJob({
  name: "comment_analysis",
  onRun: async (event, context) => {
    const { analysis, originalId, type } = event.data!;
    const { media, reddit } = context;

    const baseUrl = "https://cdn.allthepics.net/images";
    const datePath = formatDateAsPath(new Date());
    const filename = `${
      type === "analysis" ? FILENAME_ANALYSIS_PREFIX : FILENAME_ANNOTATE_PREFIX
    }_${originalId}.png`;
    const imageUrl = `${baseUrl}/${datePath}/${filename}`;

    try {
      const uploadResponse = await media.upload({
        url: imageUrl,
        type: "image",
      });

      const richTextComment =
        type === "analysis"
          ? buildReviewComment(analysis as Analysis, uploadResponse.mediaId)
          : buildAnnotateComment(analysis as Analysis, uploadResponse.mediaId);

      const comment = await reddit.submitComment({
        id: originalId as string,
        richtext: richTextComment,
      });
      await comment.distinguish(true);

      console.log(`✅ [${originalId}] Successfully posted analysis comment.`);
    } catch (e: any) {
      console.error(`[${originalId}] Error commenting: ${e.message}`, e.stack);
    }
  },
});

Devvit.addTrigger({
  event: "PostCreate",
  onEvent: async (event, context) => {
    const { post } = event;
    const { redis, reddit, scheduler } = context;

    if (!post) return;

    if (
      post.linkFlair &&
      NO_ANALYSIS_FLAIR_IDS.includes(post.linkFlair.templateId)
    )
      return;

    const postDataKey = `${POST_DATA_PREFIX}${post.id}`;

    if (!(await redis.hSetNX(postDataKey, "elo_votes", `[${INITIAL_ELO}]`))) {
      console.log(
        `[${post.id}] Post is already being processed or complete. Skipping.`
      );
      return;
    }

    console.log(
      `[${post.id}] Acquired lock and initialized data for post processing.`
    );

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

    const gemini = await getGemini(context);

    console.log(
      `[${post.id}] Sending ${geminiImageParts.length} image(s) to Gemini.`
    );

    const geminiResponse = await gemini.models.generateContent({
      model: "gemini-2.5-flash-preview-05-20",
      contents: [
        createUserContent([
          `Reddit Post Title: "${post.title}"\n\nReddit Post Body: "${post.selftext}"`,
          ...geminiImageParts,
        ]),
      ],
      config: {
        temperature: 0.7,
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
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
      analysis = JSON.parse(
        geminiResponseText.replace(/```json\n?|```/g, "").trim()
      );
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

    if (post.linkFlair?.templateId === ELO_VOTE_FLAIR_ID) {
      console.log(
        `[${post.id}] Votable flair detected. Removing Gemini Elo from analysis object.`
      );
      delete analysis.elo;
    }

    await redis.hSet(postDataKey, {
      analysis: JSON.stringify(analysis),
    });
    console.log(`[${post.id}] Analysis stored in Redis Hash.`);

    await dispatchGitHubAction(context, post.id, analysis, "analysis");

    const runAt = new Date(Date.now() + RENDER_WAIT);
    await scheduler.runJob({
      name: "comment_analysis",
      data: {
        analysis,
        originalId: post.id,
        type: "analysis",
      },
      runAt,
    });
  },
});

Devvit.addTrigger({
  event: "CommentCreate",
  onEvent: async (event, context) => {
    const { post, comment, author } = event;
    const { redis, reddit } = context;

    if (!post || !comment || !author) return;

    if (post.linkFlair?.templateId !== ELO_VOTE_FLAIR_ID) return;

    const voteCommandRegex = /!elo\s+(-?\d+)\b/i;
    const match = comment.body.match(voteCommandRegex);
    if (!match) return;

    const voteValue = parseInt(match[1], 10);

    if (author.id === post.authorId) {
      const errorComment = await reddit.submitComment({
        id: comment.id,
        text: "⚠️ Sorry, the author can't vote on their own post.",
      });
      await errorComment.distinguish();
      return;
    }

    if (author.karma < MIN_KARMA_TO_VOTE) {
      const errorComment = await reddit.submitComment({
        id: comment.id,
        text: `⚠️ Sorry, you need at least ${MIN_KARMA_TO_VOTE} karma to vote.`,
      });
      await errorComment.distinguish();
      return;
    }

    const authorAccountCreatedAt = (await reddit.getUserById(author.id))!
      .createdAt;

    if (Date.now() - authorAccountCreatedAt.getTime() < MIN_AGE_TO_VOTE_MS) {
      const minDays = Math.ceil(MIN_AGE_TO_VOTE_MS / (1000 * 60 * 60 * 24));
      const errorComment = await reddit.submitComment({
        id: comment.id,
        text: `⚠️ Sorry, your account must be at least ${minDays} days old to vote.`,
      });
      await errorComment.distinguish();
      return;
    }

    const votersKey = `${VOTERS_PREFIX}${post.id}`;
    const voteSuccessful = await redis.hSetNX(votersKey, author.id, "1");

    if (!voteSuccessful) {
      const errorComment = await reddit.submitComment({
        id: comment.id,
        text: "⚠️ It looks like you've already voted on this post.",
      });
      await errorComment.distinguish();
      return;
    }

    await handleEloVote(context, post.id, voteValue);
  },
});

function calculateMedianEloVote(votes: number[]): number {
  if (!votes.length) {
    throw new Error("No votes provided to calculate median.");
  }
  const sorted = [...votes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    // Even number of votes, return the average of the two middle ones
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // Odd number of votes, return the middle one
  return sorted[mid];
}

async function handleEloVote(
  context: TriggerContext,
  postId: string,
  userVote: number
): Promise<void> {
  const { redis, reddit } = context;
  const clampedVote = Math.max(
    MIN_VOTE_VALUE,
    Math.min(MAX_VOTE_VALUE, userVote)
  );
  const postDataKey = `${POST_DATA_PREFIX}${postId}`;

  const postData = await redis.hGetAll(postDataKey);

  // 1. Get all previous votes and add the new one.
  const eloVotes: number[] = JSON.parse(postData.elo_votes);
  eloVotes.push(clampedVote);

  // 2. Calculate the "center of gravity" using the median.
  const median = calculateMedianEloVote(eloVotes);

  // 3. For each vote, calculate its weight based on its distance from the median.
  let totalWeightedVotes = 0;
  let totalWeight = 0;
  const toleranceSquared = ELO_VOTE_TOLERANCE * ELO_VOTE_TOLERANCE;

  for (const vote of eloVotes) {
    const distance = Math.abs(vote - median);
    const weight = Math.exp(-(distance * distance) / (2 * toleranceSquared));

    totalWeightedVotes += vote * weight;
    totalWeight += weight;
  }

  // 4. The new Elo is the final weighted average.
  const newElo = Math.round(totalWeightedVotes / totalWeight),
    newVoteCount = eloVotes.length;

  // 5. Store the results
  await redis.hSet(postDataKey, {
    elo_votes: JSON.stringify(eloVotes),
  });

  console.log(
    `[${postId}] Vote: ${clampedVote}. Recalculated Elo from ${newVoteCount} votes (using median center ${median}): ${newElo}`
  );

  await redis.zAdd(LEADERBOARD_KEY, {
    score: newElo,
    member: postId,
  });
  console.log(`[${postId}] Updated global leaderboard with score: ${newElo}`);

  if (newVoteCount >= MIN_VOTES_FOR_FLAIR) {
    const flairText = `Elo: ${newElo}`;
    try {
      const post = await reddit.getPostById(postId);
      await reddit.setPostFlair({
        flairTemplateId: ELO_VOTE_FLAIR_ID,
        postId: postId,
        subredditName: post.subredditName,
        text: flairText,
      });
      console.log(`[${postId}] Flair updated to "${flairText}"`);
    } catch (e: any) {
      console.error(`[${postId}] Failed to set flair:`, e);
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
          text: "This bot is designed for comedy/entertainment only. It's analyses should not be taken seriously. ",
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
  analysis: Analysis,
  mediaId: string
): RichTextBuilder {
  return new RichTextBuilder()
    .paragraph((p) => p.text({ text: "Here's your annotation:" }))
    .image({ mediaId });
}

export default Devvit;
