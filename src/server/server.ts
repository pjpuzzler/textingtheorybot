import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis, media } from "@devvit/web/server";
import type { UiResponse } from "@devvit/web/shared";
import {
  ApiEndpoint,
  Classification,
  CLASSIFICATION_WEIGHT,
  MIN_VOTES_FOR_BADGE_CONSENSUS,
  MIN_VOTES_FOR_POST_FLAIR,
  MIN_VOTES_TO_SHOW_ELO_IN_POST_FLAIR,
  MAX_POST_AGE_TO_VOTE_MS,
  MIN_ELO,
  MAX_ELO,
  MAX_VOTE_POST_IMAGES,
  MAX_ANNOTATED_POST_IMAGES,
  interquartileMean,
  iqmToClassification,
  getEloColor,
  type CreatePostRequest,
  type CreatePostResponse,
  type UpdatePostRequest,
  type UpdatePostResponse,
  type InitResponse,
  type VoteBadgeRequest,
  type VoteBadgeResponse,
  type VoteEloRequest,
  type VoteEloResponse,
  type PostData,
  type PostImageData,
  type BadgeConsensus,
} from "../shared/api.ts";

const TITLE_ME_VOTE_REGEX = /^\[me\b.*\]/i;
const ELO_REGEX = /(\d+) Elo/;
const ANNOTATED_FLAIR_ID = "c2d007e7-ca1c-11eb-bc34-0e56c289897d";
// const ANNOTATED_FLAIR_ID = "93b0550e-0ac4-11f1-b7b0-eec33c00ce1a";
const NO_VOTES_FLAIR_TEXT = "No votes";
const MIN_VOTER_ACCOUNT_AGE_DAYS = 7;
const MIN_VOTER_TOTAL_KARMA = 10;
const ON_APP_INSTALL_ENDPOINT = "/internal/triggers/on-app-install";
const ANNOTATED_PREFIX = "[Annotated] ";
const OTHER_ELO_LABEL_REGEX = /^[A-Za-z]{1,16}$/;
const MODERATOR_CACHE_TTL_MS = 5 * 60 * 1000;
const CONSENSUS_CACHE_TTL_MS = 10 * 1000;

// ============================
// Redis key helpers
// ============================
const postKey = (pid: string) => `tt:post:${pid}`;
const votesKey = (pid: string, bid: string) => `tt:votes:${pid}:${bid}`;
const userVotesKey = (pid: string, uid: string) => `tt:uservotes:${pid}:${uid}`;
const eloVotesKey = (pid: string) => `tt:elo:${pid}`;
const userEloKey = (pid: string, uid: string) => `tt:userelo:${pid}:${uid}`;
const eloFinalizedKey = (pid: string) => `tt:elo:finalized:${pid}`;
const eloNoCountFlairAppliedKey = (pid: string) =>
  `tt:elo:finalized-nocount:v1:${pid}`;
const moderatorCacheKey = (subredditName: string, username: string) =>
  `tt:moderator:${subredditName}:${username}`;
const consensusCacheKey = (pid: string, voteWindowOpen: boolean) =>
  `tt:consensus:v1:${pid}:${voteWindowOpen ? "open" : "closed"}`;
const consensusCacheMetaKey = (pid: string, voteWindowOpen: boolean) =>
  `tt:consensus-meta:v1:${pid}:${voteWindowOpen ? "open" : "closed"}`;

async function clearConsensusCache(postId: string): Promise<void> {
  await redis.del(consensusCacheKey(postId, true));
  await redis.del(consensusCacheKey(postId, false));
  await redis.del(consensusCacheMetaKey(postId, true));
  await redis.del(consensusCacheMetaKey(postId, false));
}

async function readConsensusCache(
  postId: string,
  voteWindowOpen: boolean,
): Promise<Record<string, BadgeConsensus> | null> {
  const [rawConsensus, rawMeta] = await Promise.all([
    redis.get(consensusCacheKey(postId, voteWindowOpen)),
    redis.get(consensusCacheMetaKey(postId, voteWindowOpen)),
  ]);
  if (!rawConsensus || !rawMeta) return null;
  try {
    const meta = JSON.parse(rawMeta) as { expiresAt: number };
    if (typeof meta.expiresAt !== "number" || meta.expiresAt <= Date.now()) {
      return null;
    }
    return JSON.parse(rawConsensus) as Record<string, BadgeConsensus>;
  } catch {
    return null;
  }
}

async function writeConsensusCache(
  postId: string,
  voteWindowOpen: boolean,
  consensus: Record<string, BadgeConsensus>,
): Promise<void> {
  const expiresAt = Date.now() + CONSENSUS_CACHE_TTL_MS;
  await Promise.all([
    redis.set(
      consensusCacheKey(postId, voteWindowOpen),
      JSON.stringify(consensus),
    ),
    redis.set(
      consensusCacheMetaKey(postId, voteWindowOpen),
      JSON.stringify({ expiresAt }),
    ),
  ]);
}

// ============================
// Entry point
// ============================
export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const status =
      typeof err === "object" && err && "status" in err
        ? Number((err as { status?: number }).status)
        : 500;
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err && "message" in err
        ? String((err as { message?: string }).message)
        : String(err);
    console.error(msg);
    sendJSON(status, { error: msg, status }, rsp);
  }
}

type ErrorResponse = { error: string; status: number };
type ApiResponse =
  | InitResponse
  | CreatePostResponse
  | UpdatePostResponse
  | VoteBadgeResponse
  | VoteEloResponse;

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const url = req.url;
  if (!url || url === "/") {
    sendJSON(404, { error: "not found", status: 404 }, rsp);
    return;
  }

  const endpoint = url;
  let body: ApiResponse | UiResponse | ErrorResponse | Record<string, unknown>;

  switch (endpoint) {
    case ApiEndpoint.Init:
      body = await onInit();
      break;
    case ApiEndpoint.CreatePost:
      body = await onCreatePost(req);
      break;
    case ApiEndpoint.UpdatePost:
      body = await onUpdatePost(req);
      break;
    case ApiEndpoint.MenuCreate:
      const newPost = await reddit.submitCustomPost({
        title: "New Texting Theory Post",
        subredditName: context.subredditName ?? "TextingTheory",
        runAs: "USER",
        userGeneratedContent: {
          text: "New Texting Theory Post",
        },
      });
      body = { navigateTo: newPost.url } as UiResponse;
      break;
    case ApiEndpoint.VoteBadge:
      body = await onVoteBadge(req);
      break;
    case ApiEndpoint.VoteElo:
      body = await onVoteElo(req);
      break;
    case ON_APP_INSTALL_ENDPOINT:
      body = await onAppInstall();
      break;
    default:
      body = { error: "not found", status: 404 };
      break;
  }

  const status =
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    typeof (body as { status?: unknown }).status === "number"
      ? (body as { status: number }).status ?? 200
      : 200;
  sendJSON(status, body, rsp);
}

async function onAppInstall(): Promise<{
  type: string;
  created: boolean;
  postUrl?: string;
}> {
  const subredditName = context.subredditName;
  if (!subredditName) {
    return { type: "app-install", created: false };
  }

  const installKey = `tt:install-post:${subredditName}`;
  const existing = await redis.get(installKey);
  if (existing) {
    return { type: "app-install", created: false, postUrl: existing };
  }

  const post = await reddit.submitCustomPost({
    subredditName,
    title: "Create Texting Theory Post",
    postData: { v: 1 },
    // app is the author of the create factory post pinned to the top of the subreddit
    // every actual post is created via runAs: USER in accordance with Devvit guidelines
    runAs: "APP",
  });

  await redis.set(installKey, post.url);
  return { type: "app-install", created: true, postUrl: post.url };
}

// ============================
// Helpers
// ============================
function getPostId(): string {
  const pid = context.postId;
  if (!pid) throw new Error("No postId in context");
  return pid;
}

function getUserId(): string {
  const uid = context.userId;
  if (!uid) throw new Error("No userId in context");
  return uid;
}

async function assertCanCreatePost(): Promise<void> {
  const subredditName = context.subredditName;
  if (!subredditName) return;

  const username = await reddit.getCurrentUsername();
  if (!username) return;

  try {
    const bannedUsers = await reddit
      .getBannedUsers({
        subredditName,
        username,
        limit: 1,
        pageSize: 1,
      })
      .all();
    if (
      bannedUsers.some(
        (bannedUser: { username: string }) => bannedUser.username === username,
      )
    ) {
      throw { status: 403, message: "Banned users cannot create posts" };
    }
  } catch (err) {
    if (typeof err === "object" && err && "status" in err) {
      throw err;
    }
  }
}

async function isCurrentUserModerator(
  usernameOverride?: string | null,
): Promise<boolean> {
  const subredditName = context.subredditName;
  if (!subredditName) return false;

  const username = usernameOverride ?? (await reddit.getCurrentUsername());
  if (!username) return false;

  const cacheKey = moderatorCacheKey(subredditName, username);
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as {
        value: boolean;
        expiresAt: number;
      };
      if (
        typeof parsed.expiresAt === "number" &&
        parsed.expiresAt > Date.now()
      ) {
        return !!parsed.value;
      }
    } catch {
      // ignore malformed cache and refresh below
    }
  }

  try {
    const moderators = await reddit
      .getModerators({ subredditName, username, limit: 1, pageSize: 1 })
      .all();
    const isModerator = moderators.some(
      (moderator: { username: string }) => moderator.username === username,
    );
    await redis.set(
      cacheKey,
      JSON.stringify({
        value: isModerator,
        expiresAt: Date.now() + MODERATOR_CACHE_TTL_MS,
      }),
    );
    return isModerator;
  } catch {
    return false;
  }
}

async function assertCurrentUserModerator(): Promise<void> {
  const isModerator = await isCurrentUserModerator();
  if (!isModerator) {
    throw { status: 403, message: "Only moderators can edit posts" };
  }
}

async function getPostData(pid: string): Promise<PostData> {
  const raw = await redis.get(postKey(pid));
  if (!raw) throw new Error("Post data not found");
  const normalized = normalizePostData(JSON.parse(raw) as PostData);
  if (normalized.createdAtMs) {
    return normalized;
  }

  try {
    const postFullname = pid.startsWith("t3_") ? pid : `t3_${pid}`;
    const post = await reddit.getPostById(postFullname as `t3_${string}`);
    const createdAtMs = post?.createdAt?.getTime?.();
    if (typeof createdAtMs === "number" && Number.isFinite(createdAtMs)) {
      const enriched: PostData = {
        ...normalized,
        createdAtMs,
      };
      await redis.set(postKey(pid), JSON.stringify(enriched));
      return enriched;
    }
  } catch {
    // best-effort backfill for legacy posts
  }

  return normalized;
}

function normalizePostData(postData: PostData): PostData {
  if (Array.isArray(postData.images) && postData.images.length > 0) {
    return postData;
  }

  const fallback: PostImageData[] = [];
  if (postData.imageUrl) {
    fallback.push({
      imageUrl: postData.imageUrl,
      placements: postData.placements ?? [],
    });
  }

  return {
    ...postData,
    images: fallback,
  };
}

function getAllPlacements(postData: PostData) {
  return postData.images.flatMap((image, imageIndex) =>
    image.placements.map((placement) => ({ placement, imageIndex })),
  );
}

function isVoteWindowOpen(postData: PostData): boolean {
  if (!postData.createdAtMs) return true;
  return Date.now() - postData.createdAtMs <= MAX_POST_AGE_TO_VOTE_MS;
}

async function isEligibleVoter(
  postData: PostData,
  userId: string,
): Promise<boolean> {
  if (userId === postData.creatorId) return false;

  const user = await reddit.getUserById(userId as `t2_${string}`);
  if (!user) return false;

  const ageMs = Date.now() - user.createdAt.getTime();
  const minAgeMs = MIN_VOTER_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs < minAgeMs) return false;

  const totalKarma = (user.linkKarma || 0) + (user.commentKarma || 0);
  if (totalKarma < MIN_VOTER_TOTAL_KARMA) return false;

  const subredditName = context.subredditName;
  if (subredditName) {
    try {
      const bannedUsers = await reddit
        .getBannedUsers({
          subredditName,
          username: user.username,
          limit: 1,
          pageSize: 1,
        })
        .all();
      if (
        bannedUsers.some(
          (bannedUser: { username: string }) =>
            bannedUser.username === user.username,
        )
      ) {
        return false;
      }
    } catch {
      // best-effort banned check
    }
  }

  return true;
}

function getTitleEmoji(elo: number): string {
  if (elo >= 2500) return ":gm:";
  if (elo >= 2400) return ":im:";
  if (elo >= 2300) return ":fm:";
  if (elo >= 2200) return ":cm:";
  return "";
}

function getEloTargetLabel(postData: PostData): string {
  if (postData.eloSide === "left") return "left";
  if (postData.eloSide === "me") return "me";
  if (postData.eloSide === "other")
    return postData.eloOtherText?.trim() || "other";
  return "right";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findAsyncImagePost(
  subredditName: string,
  title: string,
  imageUrl: string,
): Promise<{ id: string; url: string } | null> {
  const username = await reddit.getCurrentUsername();
  const normalizedImage = imageUrl.split("?")[0] ?? imageUrl;

  for (let attempt = 0; attempt < 2; attempt++) {
    const posts = await reddit
      .getNewPosts({ subredditName, limit: 25, pageSize: 25 })
      .all();

    const found = posts.find((post) => {
      const sameTitle = post.title === title;
      const sameUser = username ? post.authorName === username : true;
      const postUrl = (post.url || "").split("?")[0] ?? "";
      const sameImage = postUrl === normalizedImage;
      return sameTitle && sameUser && sameImage;
    });

    if (found) {
      return { id: found.id, url: found.url };
    }
    await sleep(200);
  }

  return null;
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString()) as T;
}

function sendJSON<T>(status: number, body: T, rsp: ServerResponse): void {
  const json = JSON.stringify(body);
  rsp.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  rsp.end(json);
}

// ============================
// Init
// ============================
async function onInit(): Promise<InitResponse> {
  const postId = getPostId();
  const userId = getUserId();
  const currentUsername = await reddit.getCurrentUsername();
  const username = currentUsername ?? "unknown";
  const isModerator = await isCurrentUserModerator(currentUsername);

  let postData: PostData | null = null;
  try {
    postData = await getPostData(postId);
  } catch {
    /* no post data */
  }

  // Badge consensus
  const consensus: Record<string, BadgeConsensus> = {};
  const userVotes: Record<string, Classification> = {};

  // ELO
  let userElo: number | null = null;
  let consensusElo: number | null = null;
  let eloVoteCount = 0;

  if (postData) {
    const [uvRaw, userEloRaw, allEloRaw] = await Promise.all([
      redis.hGetAll(userVotesKey(postId, userId)),
      redis.get(userEloKey(postId, userId)),
      redis.get(eloVotesKey(postId)),
    ]);

    for (const [bid, cls] of Object.entries(uvRaw)) {
      userVotes[bid] = cls as Classification;
    }

    if (userEloRaw) userElo = Number(userEloRaw);
    if (allEloRaw) {
      const eloArr = JSON.parse(allEloRaw) as number[];
      eloVoteCount = eloArr.length;
      if (eloArr.length > 0) {
        consensusElo = Math.round(interquartileMean(eloArr));
      }
    }

    await finalizeEloIfTimedOut(postId, postData);

    if (postData.mode === "vote") {
      const voteWindowOpen = isVoteWindowOpen(postData);
      const cachedConsensus = await readConsensusCache(postId, voteWindowOpen);
      if (cachedConsensus) {
        Object.assign(consensus, cachedConsensus);
      } else {
        const placementList = getAllPlacements(postData).map(
          ({ placement }) => placement,
        );
        const consensusEntries = await Promise.all(
          placementList.map(async (placement) => {
            const allVotes = await redis.hGetAll(
              votesKey(postId, placement.id),
            );
            const computed = computeBadgeConsensus(allVotes);
            if (
              !voteWindowOpen &&
              !computed.classification &&
              computed.totalVotes > 0
            ) {
              computed.classification = iqmToClassification(
                computed.iqm,
                computed.voteCounts,
                computed.totalVotes,
              );
            }
            return [placement.id, computed] as const;
          }),
        );

        for (const [placementId, computed] of consensusEntries) {
          consensus[placementId] = computed;
        }

        await writeConsensusCache(postId, voteWindowOpen, consensus);
      }
    }
  }

  return {
    type: "init",
    postId,
    username,
    userId,
    isModerator,
    postData,
    consensus,
    userVotes,
    userElo,
    consensusElo,
    eloVoteCount,
  };
}

async function removeVotesForBadge(
  postId: string,
  badgeId: string,
): Promise<void> {
  await redis.del(votesKey(postId, badgeId));
}

async function removeBookVotesForBadge(
  postId: string,
  badgeId: string,
): Promise<void> {
  const allVotes = await redis.hGetAll(votesKey(postId, badgeId));
  const bookVoterIds = Object.entries(allVotes)
    .filter(([, cls]) => cls === Classification.BOOK)
    .map(([userId]) => userId);
  if (bookVoterIds.length === 0) return;
  await redis.hDel(votesKey(postId, badgeId), bookVoterIds);
}

async function onUpdatePost(req: IncomingMessage): Promise<UpdatePostResponse> {
  await assertCurrentUserModerator();

  const postId = getPostId();
  const body = await readJSON<UpdatePostRequest>(req);
  if (!body.images?.length) throw new Error("At least one image is required");

  const existingPost = await getPostData(postId);
  const maxImages =
    existingPost.mode === "annotated"
      ? MAX_ANNOTATED_POST_IMAGES
      : MAX_VOTE_POST_IMAGES;
  if (body.images.length > maxImages) {
    throw new Error(`Max ${maxImages} images`);
  }

  const uploads: PostImageData[] = [];
  for (const image of body.images) {
    const dataUrl = `data:${image.imageMimeType};base64,${image.imageData}`;
    const upload = await media.upload({ url: dataUrl, type: "image" });
    uploads.push({
      imageUrl: upload.mediaUrl,
      imageWidth: image.imageWidth,
      imageHeight: image.imageHeight,
      placements: image.placements,
    });
  }

  const oldPlacements = existingPost.images
    .flatMap((image) => image.placements)
    .map((placement) => ({ id: placement.id, order: placement.order ?? 0 }));
  const newPlacements = uploads
    .flatMap((image) => image.placements)
    .map((placement) => ({ id: placement.id, order: placement.order ?? 0 }));

  const oldIds = new Set(oldPlacements.map((placement) => placement.id));
  const newIds = new Set(newPlacements.map((placement) => placement.id));

  for (const oldId of oldIds) {
    if (!newIds.has(oldId)) {
      await removeVotesForBadge(postId, oldId);
    }
  }

  const oldOrderMap = new Map(
    oldPlacements.map((placement) => [placement.id, placement.order]),
  );
  const orderChanged = newPlacements.some(
    (placement) => oldOrderMap.get(placement.id) !== placement.order,
  );

  if (orderChanged) {
    for (const badgeId of newIds) {
      await removeBookVotesForBadge(postId, badgeId);
    }
  }

  const updatedPost: PostData = {
    ...existingPost,
    images: uploads,
  };
  await redis.set(postKey(postId), JSON.stringify(updatedPost));
  await clearConsensusCache(postId);

  const subredditName = context.subredditName ?? "TextingTheory";
  const shortPostId = postId.startsWith("t3_") ? postId.slice(3) : postId;
  const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${shortPostId}/`;

  return {
    type: "update-post",
    postId,
    postUrl,
  };
}

// ============================
// Create Post
// ============================
async function onCreatePost(
  req: IncomingMessage,
): Promise<CreatePostResponse | UiResponse> {
  const userId = getUserId();
  const body = await readJSON<CreatePostRequest>(req);

  await assertCanCreatePost();

  if (body.mode === "vote" && body.eloSide === "other") {
    const other = (body.eloOtherText ?? "").trim();
    if (/^me$/i.test(other)) {
      body.eloSide = "me";
      body.eloOtherText = undefined;
    } else {
      if (!OTHER_ELO_LABEL_REGEX.test(other)) {
        throw new Error("Other vote target must be letters only (max 16)");
      }
      body.eloOtherText = other;
    }
  }

  if (!body.images?.length) throw new Error("At least one image is required");
  const maxImages =
    body.mode === "annotated"
      ? MAX_ANNOTATED_POST_IMAGES
      : MAX_VOTE_POST_IMAGES;
  if (body.images.length > maxImages)
    throw new Error(`Max ${maxImages} images`);

  const uploads: PostImageData[] = [];
  for (const image of body.images) {
    const dataUrl = `data:${image.imageMimeType};base64,${image.imageData}`;
    const upload = await media.upload({ url: dataUrl, type: "image" });
    uploads.push({
      imageUrl: upload.mediaUrl,
      imageWidth: image.imageWidth,
      imageHeight: image.imageHeight,
      placements: image.placements,
    });
  }

  const baseTitle = body.title || "Texting Theory";
  const title =
    body.mode === "annotated" && !baseTitle.startsWith(ANNOTATED_PREFIX)
      ? `${ANNOTATED_PREFIX}${baseTitle}`
      : baseTitle;
  const subredditName = context.subredditName ?? "TextingTheory";
  let postId = "";
  let postUrl = "";

  if (body.mode === "annotated") {
    try {
      const post = await reddit.submitPost({
        subredditName,
        title,
        kind: "image",
        runAs: "USER",
        flairId: ANNOTATED_FLAIR_ID,
        imageUrls: [uploads[0]!.imageUrl],
      });
      postId = post.id;
      postUrl = post.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("being created asynchronously")) {
        throw err;
      }

      const found = await findAsyncImagePost(
        subredditName,
        title,
        uploads[0]!.imageUrl,
      );
      if (!found) {
        postId = `pending-${Date.now()}`;
        postUrl = `https://www.reddit.com/r/${subredditName}/new/`;
      } else {
        postId = found.id;
        postUrl = found.url;
      }
    }
  } else {
    const post = await reddit.submitCustomPost({
      title,
      postData: { v: 1 },
      runAs: "USER",
      userGeneratedContent: {
        text: title,
        imageUrls: uploads.map((upload) => upload.imageUrl),
      },
    });
    postId = post.id;
    postUrl = post.url;

    const postFullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;
    await reddit.setPostFlair({
      subredditName,
      postId: postFullname as `t3_${string}`,
      text: NO_VOTES_FLAIR_TEXT,
      textColor: "light",
    });
  }

  const pd: PostData = {
    mode: body.mode,
    images: uploads,
    creatorId: userId,
    title,
    createdAtMs: Date.now(),
    eloSide: body.eloSide,
    eloOtherText: body.eloOtherText,
  };
  if (body.mode !== "annotated") {
    await redis.set(postKey(postId), JSON.stringify(pd));
  }

  return {
    type: "create-post",
    postId,
    postUrl,
  };
}

// ============================
// Vote Badge
// ============================
async function onVoteBadge(req: IncomingMessage): Promise<VoteBadgeResponse> {
  const postId = getPostId();
  const userId = getUserId();
  const body = await readJSON<VoteBadgeRequest>(req);
  const postData = await getPostData(postId);

  if (postData.creatorId === userId) {
    throw { status: 403, message: "You can't vote on your own post" };
  }
  if (!isVoteWindowOpen(postData)) {
    throw { status: 403, message: "Voting has ended for this post" };
  }

  const allPlacements = getAllPlacements(postData);
  const found = allPlacements.find(
    ({ placement }) => placement.id === body.badgeId,
  );
  if (!found) throw new Error("Badge not found");

  const eligible = await isEligibleVoter(postData, userId);

  // Always store local user vote for UX, only count eligible votes toward consensus
  await redis.hSet(userVotesKey(postId, userId), {
    [body.badgeId]: body.classification,
  });
  if (eligible) {
    await redis.hSet(votesKey(postId, body.badgeId), {
      [userId]: body.classification,
    });
  }

  const invalidatedBadgeIds = await invalidateBrokenBookVotes(
    postId,
    userId,
    postData,
    eligible,
  );

  // Recompute all consensus
  const consensusEntries = await Promise.all(
    allPlacements.map(async ({ placement: p }) => {
      const allVotes = await redis.hGetAll(votesKey(postId, p.id));
      return [p.id, computeBadgeConsensus(allVotes)] as const;
    }),
  );
  const allConsensus: Record<string, BadgeConsensus> = {};
  for (const [badgeId, computed] of consensusEntries) {
    allConsensus[badgeId] = computed;
  }

  await clearConsensusCache(postId);
  await writeConsensusCache(postId, true, allConsensus);

  return {
    type: "vote-badge",
    consensus: allConsensus[body.badgeId]!,
    allConsensus,
    counted: eligible,
    invalidatedBadgeIds,
  };
}

async function invalidateBrokenBookVotes(
  postId: string,
  userId: string,
  postData: PostData,
  eligible: boolean,
): Promise<string[]> {
  const currentUserVotes = await redis.hGetAll(userVotesKey(postId, userId));
  const invalidatedBadgeIds: string[] = [];

  const placements = postData.images
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let canContinueBook = true;
  for (const placement of placements) {
    const vote = currentUserVotes[placement.id] as Classification | undefined;
    if (!vote) {
      canContinueBook = false;
      continue;
    }

    if (vote === Classification.BOOK) {
      if (!canContinueBook) {
        invalidatedBadgeIds.push(placement.id);
        delete currentUserVotes[placement.id];
      }
      continue;
    }

    canContinueBook = false;
  }

  for (const badgeId of invalidatedBadgeIds) {
    await redis.hDel(userVotesKey(postId, userId), [badgeId]);
    if (eligible) {
      await redis.hDel(votesKey(postId, badgeId), [userId]);
    }
  }

  return invalidatedBadgeIds;
}

// ============================
// Vote ELO
// ============================
async function onVoteElo(req: IncomingMessage): Promise<VoteEloResponse> {
  const postId = getPostId();
  const userId = getUserId();
  const body = await readJSON<VoteEloRequest>(req);
  const postData = await getPostData(postId);

  if (postData.creatorId === userId) {
    throw { status: 403, message: "You can't vote on your own post" };
  }
  if (!isVoteWindowOpen(postData)) {
    throw { status: 403, message: "Voting has ended for this post" };
  }

  const elo = Math.max(MIN_ELO, Math.min(MAX_ELO, body.elo));
  const eligible = await isEligibleVoter(postData, userId);

  // Always store local user ELO for UX indicator
  await redis.set(userEloKey(postId, userId), String(elo));

  // Only eligible votes are counted
  const allEloVoters = await redis.hGetAll(`tt:elovoters:${postId}`);
  if (eligible) {
    allEloVoters[userId] = String(elo);
    await redis.hSet(`tt:elovoters:${postId}`, { [userId]: String(elo) });
  }

  const eloArr = Object.values(allEloVoters).map(Number);
  await redis.set(eloVotesKey(postId), JSON.stringify(eloArr));

  const voteCount = eloArr.length;
  const consensusElo =
    voteCount > 0 ? Math.round(interquartileMean(eloArr)) : elo;

  if (voteCount > 0 && isVoteWindowOpen(postData)) {
    await updatePostFlair(postId, consensusElo, voteCount, {
      showVisibleElo: voteCount >= MIN_VOTES_TO_SHOW_ELO_IN_POST_FLAIR,
      colorize: false,
      tryUserFlair: false,
    });
  }

  await finalizeEloIfTimedOut(postId, postData);

  return {
    type: "vote-elo",
    consensusElo,
    voteCount,
    counted: eligible,
    targetLabel: getEloTargetLabel(postData),
  };
}

// ============================
// Flair
// ============================
async function updatePostFlair(
  postId: string,
  elo: number,
  voteCount: number,
  options?: {
    showVisibleElo?: boolean;
    colorize?: boolean;
    tryUserFlair?: boolean;
    includeVoteCount?: boolean;
  },
): Promise<void> {
  try {
    const showVisibleElo = options?.showVisibleElo ?? false;
    const colorize = options?.colorize ?? false;
    const shouldTryUserFlair = options?.tryUserFlair ?? false;
    const includeVoteCount = options?.includeVoteCount ?? true;
    const visibleEloText = showVisibleElo ? `${elo} Elo` : "??? Elo";
    const formattedVoteCount = voteCount.toLocaleString("en-US");
    const flairText = includeVoteCount
      ? `${visibleEloText} (${formattedVoteCount} ${
          voteCount === 1 ? "Vote" : "Votes"
        })`
      : visibleEloText;
    const bgColor = getEloColor(elo);
    const subredditName = context.subredditName;
    if (!subredditName) return;

    const postFullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;

    const flairPayload: {
      subredditName: string;
      postId: `t3_${string}`;
      text: string;
      textColor: "light";
      backgroundColor?: string;
    } = {
      subredditName,
      postId: postFullname as `t3_${string}`,
      text: flairText,
      textColor: "light",
    };
    if (colorize) {
      flairPayload.backgroundColor = bgColor;
    }
    await reddit.setPostFlair(flairPayload);

    if (shouldTryUserFlair) {
      await tryUpdateUserFlair(postId, elo, voteCount);
    }
  } catch (err) {
    console.error("Failed to update flair:", err);
  }
}

async function finalizeEloIfTimedOut(
  postId: string,
  postData: PostData,
): Promise<void> {
  if (postData.mode !== "vote") return;
  if (isVoteWindowOpen(postData)) return;

  const finalized = await redis.get(eloFinalizedKey(postId));
  const noCountApplied =
    (await redis.get(eloNoCountFlairAppliedKey(postId))) === "1";
  const alreadyFinalized = finalized === "1";
  if (alreadyFinalized && noCountApplied) {
    return;
  }

  const allEloRaw = await redis.get(eloVotesKey(postId));
  const eloArr = allEloRaw ? (JSON.parse(allEloRaw) as number[]) : [];
  const voteCount = eloArr.length;

  if (voteCount < MIN_VOTES_FOR_POST_FLAIR) {
    await redis.set(eloFinalizedKey(postId), "1");
    await redis.set(eloNoCountFlairAppliedKey(postId), "1");
    return;
  }

  const consensusElo = Math.round(interquartileMean(eloArr));
  const showVisibleElo = voteCount >= MIN_VOTES_TO_SHOW_ELO_IN_POST_FLAIR;

  await updatePostFlair(postId, consensusElo, voteCount, {
    showVisibleElo: true,
    colorize: showVisibleElo,
    tryUserFlair: showVisibleElo && !alreadyFinalized,
    includeVoteCount: false,
  });

  await redis.set(eloFinalizedKey(postId), "1");
  await redis.set(eloNoCountFlairAppliedKey(postId), "1");
}

async function tryUpdateUserFlair(
  postId: string,
  elo: number,
  voteCountAtTimeout: number,
): Promise<void> {
  try {
    const postData = await getPostData(postId);
    const isMeTarget =
      postData.eloSide === "me" || TITLE_ME_VOTE_REGEX.test(postData.title);
    if (!isMeTarget) return;

    const subredditName = context.subredditName;
    if (!subredditName) return;

    const author = await reddit.getUserById(
      postData.creatorId as `t2_${string}`,
    );
    if (!author) return;

    const postAuthorFlair = await author.getUserFlairBySubreddit(subredditName);
    const eloUserFlairMatch = postAuthorFlair?.flairText?.match(ELO_REGEX);
    if (postAuthorFlair?.flairText && !eloUserFlairMatch) return;
    let curUserElo: number | undefined;
    if (eloUserFlairMatch?.[1]) curUserElo = parseInt(eloUserFlairMatch[1], 10);

    if (curUserElo && elo <= curUserElo) return;

    const titleEmoji = getTitleEmoji(elo);
    const flairText = `${titleEmoji}${elo} Elo`;

    await reddit.setUserFlair({
      subredditName,
      username: author.username,
      text: flairText,
      backgroundColor: getEloColor(elo),
      textColor: "light",
    });

    const shortPostId = postId.startsWith("t3_") ? postId.slice(3) : postId;
    const postUrl = `https://www.reddit.com/r/${subredditName}/comments/${shortPostId}/`;
    const formattedVoteCount = voteCountAtTimeout.toLocaleString("en-US");
    await reddit.sendPrivateMessage({
      subject: `Your user flair on r/${subredditName} has been updated`,
      text: `Your [post](${postUrl}) on r/${subredditName} has closed voting after 24 hours with ${formattedVoteCount} Elo ${
        voteCountAtTimeout === 1 ? "vote" : "votes"
      }. Final consensus is ${elo} Elo, and your user flair has been updated automatically. You can clear or change your flair at any time from subreddit flair settings.`,
      to: author.username,
    });
  } catch (err) {
    console.error("Failed to update user flair:", err);
  }
}

// ============================
// Consensus computation
// ============================
function computeBadgeConsensus(
  allVotes: Record<string, string>,
): BadgeConsensus {
  const entries = Object.entries(allVotes);
  const totalVotes = entries.length;

  if (totalVotes === 0) {
    return { classification: null, totalVotes: 0, voteCounts: {}, iqm: 0 };
  }

  const voteCounts: Partial<Record<Classification, number>> = {};
  const weights: number[] = [];

  for (const [, cls] of entries) {
    const c = cls as Classification;
    voteCounts[c] = (voteCounts[c] ?? 0) + 1;
    const w = CLASSIFICATION_WEIGHT[c] ?? 0;
    weights.push(w);
  }

  const iqm = interquartileMean(weights);

  let classification: Classification | null = null;
  if (totalVotes >= MIN_VOTES_FOR_BADGE_CONSENSUS) {
    classification = iqmToClassification(iqm, voteCounts, totalVotes);
  }

  return { classification, totalVotes, voteCounts, iqm };
}
