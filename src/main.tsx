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
const KV_ANALYSIS_PREFIX = "analysis:";

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

    // Rule 1: Book not first and not preceded by Book
    if (
      msg.classification === Classification.BOOK &&
      i > 0 &&
      prev.classification !== Classification.BOOK
    ) {
      msg.classification = Classification.GOOD;
    }

    // Rule 2: Abandon, Checkmated, Resign, Timeout
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

    // Rule 3: Winner not last or not preceded by finalizing
    if (
      msg.classification === Classification.WINNER &&
      (i < messages.length - 1 ||
        !(prev && prev.side !== msg.side && isFinalizing(prev.classification)))
    ) {
      msg.classification = Classification.GOOD;
    }

    // Rule 4: Draw not last and not followed by Draw from opponent (max of 2 in a row)
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
  if (!token) {
    throw new Error("Missing GitHub token in the app configuration.");
  }

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
      inputs: {
        original_id,
        render_payload: JSON.stringify(analysis),
        type,
      },
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

    const postId = context.postId as string;
    const analysisJson = (await redis.get(
      `${KV_ANALYSIS_PREFIX}${postId}`
    )) as string;
    const analysis: Analysis = JSON.parse(analysisJson);

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

    const currentDate = new Date();
    const runAt = new Date(currentDate.getTime() + RENDER_WAIT);

    console.log("waiting for job to finish");

    await scheduler.runJob({
      name: "comment_analysis",
      data: {
        analysis,
        originalId: comment.id,
        type: "annotate",
      },
      runAt,
    });

    ui.showToast(
      `Analysis requested successfully, check back in ~${Math.floor(
        RENDER_WAIT / 1000
      )}s!`
    );
  }
);

Devvit.addMenuItem({
  label: "Annotate",
  location: "post",
  onPress: async (event, context) => {
    const { targetId } = event;
    const { reddit, redis, ui } = context;

    let targetPost;
    try {
      targetPost = await reddit.getPostById(targetId);
    } catch (e) {
      console.error(
        `[${targetId}] Failed to fetch parent post for annotation request`
      );
      ui.showToast(
        "An error occured, please try again later or on a different post."
      );
      return;
    }

    const analysisJson = await redis.get(
      `${KV_ANALYSIS_PREFIX}${targetPost.id}`
    );
    if (!analysisJson) {
      ui.showToast("No analysis found for this post.");
      return;
    }

    const analysis: Analysis = JSON.parse(analysisJson);

    ui.showForm(annotateAnalysisForm, { analysis, postId: targetPost.id });
  },
});

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

    console.log(`Allthepics url: ${imageUrl}`);

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
      throw e;
    }
  },
});

Devvit.addTrigger({
  event: "PostCreate",
  onEvent: async (event, context) => {
    const { post } = event;
    const { redis, reddit, scheduler } = context;

    if (!post) {
      console.log(`Post is undefined. Skipping.`);
      return;
    }

    if (
      post.linkFlair &&
      (post.linkFlair.templateId === "c2d007e7-ca1c-11eb-bc34-0e56c289897d" ||
        post.linkFlair.templateId === "edde53c6-7cb1-11ee-8104-3e49ebced071")
    ) {
      console.log(
        "Post has flair which does not require annotation. Skipping."
      );
      return;
    }

    const redisExists = await redis.exists(`${KV_ANALYSIS_PREFIX}${post.id}`);

    if (redisExists > 0) {
      console.log(`[${post?.id}] Already analyzed post. Skipping.`);
      return;
    }

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

    if (imageUrls.length === 0) {
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

    if (geminiImageParts.length === 0) {
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
        temperature: 0.3,
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

    await redis.set(
      `${KV_ANALYSIS_PREFIX}${post.id}`,
      JSON.stringify(analysis)
    );
    console.log(`[${post.id}] Analysis stored in KV Store.`);

    await dispatchGitHubAction(context, post.id, analysis, "analysis");

    const currentDate = new Date();
    const runAt = new Date(currentDate.getTime() + RENDER_WAIT);

    console.log("Waiting to run job...");

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
    .paragraph((paragraph) => paragraph.text({ text: "✪ Game Review" }))
    .paragraph((paragraph) => paragraph.text({ text: analysis.commentary }))
    .image({ mediaId })
    .paragraph((paragraph) => paragraph.text({ text: analysis.opening_name }))
    .table((table) => {
      if (hasLeft)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.left && analysis.elo.left
                ? `${analysis.color.left.label} (${analysis.elo.left})`
                : "",
          })
        );
      table.headerCell({ columnAlignment: "center" }, () => {});
      if (hasRight)
        table.headerCell({ columnAlignment: "center" }, (cell) =>
          cell.text({
            text:
              analysis.color.right && analysis.elo.right
                ? `${analysis.color.right.label} (${analysis.elo.right})`
                : "",
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
    .paragraph((paragraph) =>
      paragraph.link({ text: "about the bot", url: aboutBotLink })
    );
}

function buildAnnotateComment(
  analysis: Analysis,
  mediaId: string
): RichTextBuilder {
  return new RichTextBuilder()
    .paragraph((paragraph) =>
      paragraph.text({ text: "Here's your annotation:" })
    )
    .image({ mediaId });
}

export default Devvit;
