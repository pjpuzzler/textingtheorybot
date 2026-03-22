import { navigateTo, requestExpandedMode, showToast } from "@devvit/client";
import {
  ApiEndpoint,
  BADGE_INFO,
  BADGE_HINTS,
  RESULT_HINTS,
  RESULT_INFO,
  RESULT_PICKER_OPTIONS,
  isResultVote,
  Classification,
  getEloColor,
  MIN_VOTES_FOR_BADGE_CONSENSUS,
  MAX_POST_AGE_TO_VOTE_MS,
  MIN_ELO,
  MAX_ELO,
  interquartileMean,
  type InitResponse,
  type InspectVotesResponse,
  type BadgeVoteOption,
  type BadgeConsensus,
  type BadgePlacement,
  type PostData,
} from "../shared/api.ts";

let postData: PostData | null = null;
let consensus: Record<string, BadgeConsensus> = {};
let userVotes: Record<string, BadgeVoteOption> = {};
const localVoteGraceUntil: Record<string, number> = {};
const recentVoteAnimationUntil: Record<string, number> = {};
let userElo: number | null = null;
let lastSubmittedElo: number | null = null;
let activeImageIndex = 0;
let currentPostId = "";
let currentSubredditName: string | null = null;
let viewerOwnsPost = false;
let viewerUserId = "";
let viewerIsLoggedIn = false;
let viewerIsModerator = false;
let hasEverSubmittedBadgeVote = false;
let refreshTimer: number | null = null;
let voteLockCountdownTimer: number | null = null;
let imageLoadToken = 0;
let lastBadgeLayoutKey = "";
let lastUserInteractionAt = 0;
let suppressCanvasExpandUntil = 0;
let badgesVisible = true;
let imageSlideDirection: "prev" | "next" | null = null;
let pendingSlideSnapshot: {
  imageSrc: string;
  badgesHtml: string;
  badgesLeft: string;
  badgesTop: string;
  badgesWidth: string;
  badgesHeight: string;
} | null = null;
let navTransitionInFlight = false;
let queuedNavIndex: number | null = null;
let postLayoutRaf: number | null = null;
let loadingIndicatorTimer: number | null = null;
let loadingIndicatorShownAt = 0;
let loadingIndicatorHideTimer: number | null = null;
const PAGE_SLIDE_DURATION_MS = 210;
const LOADING_INDICATOR_MIN_VISIBLE_MS = 140;
const LOADING_INDICATOR_SHOW_DELAY_MS_COMPACT = 180;
const SWIPE_COMMIT_MIN_PX = 48;
const SWIPE_COMMIT_RATIO = 0.16;
const SWIPE_SETTLE_DURATION_MS = 215;
const SWIPE_RESET_DURATION_MS = 260;
const ELO_THUMB_SIZE_PX = 24;
const ELO_BUBBLE_HIDE_DELAY_MS = 900;
const UNVOTED_RING_WIDTH_PX = 2;
const BADGE_VISIBILITY_TOGGLE_ENABLED = false;
const PICKER_ITEM_CLICK_FALLBACK_GUARD_MS = 500;
const PICKER_CLOSE_GUARD_AFTER_OPEN_MS = 180;
const RECENT_VOTE_ANIMATION_MS = 900;
const REFRESH_AFTER_VOTE_GUARD_MS = 1400;
let lastPickerOpenAt = 0;
let lastPickerItemVoteAt = 0;
let suppressPickerReopenUntil = 0;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeTracking = false;
let swipeHorizontal = false;
let swipeLastDx = 0;
let suppressCanvasClickUntil = 0;
let suppressSyntheticReleaseClickUntil = 0;
let swallowSyntheticReleaseClick = false;
let swipeStartedNearEdge = false;
let pendingBadgeTapPlacement: BadgePlacement | null = null;
let pendingBadgeTapNeedsManualOpen = false;
let swipePreviewIndex: number | null = null;
let swipePreviewImg: HTMLImageElement | null = null;
let swipePreviewBadges: HTMLDivElement | null = null;
let committedPreviewImg: HTMLImageElement | null = null;
let committedPreviewBadges: HTMLDivElement | null = null;
const imagePreloadCache = new Map<string, HTMLImageElement>();
let lastPersistedPageKey = "";
let lastPersistedPageIndex = -1;
let swipeInputMode: "touch" | "pointer" | null = null;
let swipePointerId: number | null = null;
let eloPointerId: number | null = null;
let eloTouchId: number | null = null;
let eloBubbleHideTimer: number | null = null;
let eloInteractionFailsafeTimer: number | null = null;
let suppressEloBubbleUntil = 0;
let swipeTransformRaf: number | null = null;
let pendingActiveSwipeDx = 0;
let pendingPreviewSwipeDx: number | null = null;
let suppressRefreshUntil = 0;
let inspectorReloadToken = 0;
let inspectData: InspectVotesResponse | null = null;
let inspectModeActive = false;
let inspectDetailTarget: { kind: "elo" } | { kind: "badge"; badgeId: string } | null = null;

type StoredVoteSnapshot = {
  updatedAt: number;
  votes: Record<
    string,
    {
      vote: BadgeVoteOption;
      graceUntil: number;
    }
  >;
};

const $ = (id: string) => document.getElementById(id)!;

const loadingEl = $("loading") as HTMLDivElement;
const postEl = $("post") as HTMLDivElement;
const canvasEl = $("canvas") as HTMLDivElement;
const canvasImg = $("canvas-img") as HTMLImageElement;
const badgesEl = $("badges") as HTMLDivElement;
const imageNav = $("image-nav") as HTMLDivElement;
const imgPrev = $("img-prev") as HTMLButtonElement;
const imgNext = $("img-next") as HTMLButtonElement;
const imgDots = $("img-dots") as HTMLDivElement;
const pageChip = $("page-chip") as HTMLDivElement;
const postMenuEl = $("post-menu") as HTMLDivElement;
const menuToggleBtn = $("menu-toggle") as HTMLButtonElement;
const menuDropdownEl = $("menu-dropdown") as HTMLDivElement;
const menuInfoBtn = document.getElementById("menu-info") as HTMLButtonElement | null;
const menuCreateBtn = $("menu-create") as HTMLButtonElement;
const menuEditBtn = $("menu-edit") as HTMLButtonElement;
const menuInspectBtn = $("menu-inspect") as HTMLButtonElement;
const badgeVisToggleBtn = $("badge-vis-toggle") as HTMLButtonElement;
const inspectFooterEl = $("inspect-footer") as HTMLDivElement;
const inspectEloBtn = $("inspect-elo-btn") as HTMLButtonElement;
const eloEl = $("elo") as HTMLDivElement;
const eloLoginEl = document.getElementById(
  "elo-login",
) as HTMLDivElement | null;
const eloLoginTextEl = document.getElementById(
  "elo-login-text",
) as HTMLDivElement | null;
const eloSlider = $("elo-slider") as HTMLInputElement;
const eloBubble = $("elo-bubble") as HTMLDivElement;
const eloBubbleText = $("elo-bubble-text") as HTMLSpanElement;
const eloBtn = $("elo-btn") as HTMLButtonElement;
const eloGmTick = $("elo-gm-tick") as HTMLDivElement;
const createPrompt = $("create-prompt") as HTMLDivElement;
const createBtn = $("create-btn") as HTMLButtonElement;
const voteHintEl = $("vote-hint") as HTMLDivElement;

const pickerOvl = $("picker-overlay") as HTMLDivElement;
const pickerBg = $("picker-bg") as HTMLDivElement;
const pickerTitle = $("picker-title") as HTMLDivElement;
const pickerBody = $("picker-body") as HTMLDivElement;
const inspectorOvl = $("inspector-overlay") as HTMLDivElement;
const inspectorBg = $("inspector-bg") as HTMLDivElement;
const inspectorTitleEl = $("inspector-title") as HTMLDivElement;
const inspectorMetaEl = $("inspector-meta") as HTMLDivElement;
const inspectorCloseBtn = $("inspector-close") as HTMLButtonElement;
const inspectorBody = $("inspector-body") as HTMLDivElement;
const query = new URLSearchParams(window.location.search);
const isExpandedView =
  query.get("expanded") === "1" ||
  window.location.pathname.endsWith("/post-expanded.html");

document.body.classList.toggle("expanded-view", isExpandedView);

if (isAndroidLike()) {
  canvasEl.style.touchAction = "none";
  badgesEl.style.touchAction = "none";
  imageNav.style.touchAction = "none";
}

function pageStateStorageKey(): string | null {
  return currentPostId ? `tt:page:${currentPostId}` : null;
}

function voteStateStorageKey(): string | null {
  return currentPostId ? `tt:votes:${currentPostId}` : null;
}

function expandedInspectIntentKey(): string {
  return "tt:expanded-intent";
}

function setExpandedInspectIntent(): void {
  try {
    if (!currentPostId) return;
    window.localStorage.setItem(
      expandedInspectIntentKey(),
      JSON.stringify({ postId: currentPostId, mode: "inspect", createdAt: Date.now() }),
    );
  } catch {
    // ignore storage issues in embedded views
  }
}

function consumeExpandedInspectIntent(): boolean {
  try {
    const raw = window.localStorage.getItem(expandedInspectIntentKey());
    if (!raw) return false;
    window.localStorage.removeItem(expandedInspectIntentKey());
    const parsed = JSON.parse(raw) as {
      postId?: string;
      mode?: string;
      createdAt?: number;
    };
    const ageMs = Date.now() - (parsed.createdAt ?? 0);
    return (
      parsed.postId === currentPostId &&
      parsed.mode === "inspect" &&
      ageMs >= 0 &&
      ageMs < 60_000
    );
  } catch {
    return false;
  }
}

function navigateExternal(url: string | null): void {
  if (!url) return;
  navigateTo(url);
}

function readInspectTargetFromLocation():
  | { kind: "elo" }
  | { kind: "badge"; badgeId: string }
  | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("inspect") !== "1") return null;
  const target = params.get("inspectTarget");
  if (target === "elo") return { kind: "elo" };
  if (target === "badge") {
    const badgeId = params.get("badgeId");
    if (badgeId) return { kind: "badge", badgeId };
  }
  return null;
}

function updateInspectLocation(
  target:
    | { kind: "elo" }
    | { kind: "badge"; badgeId: string }
    | null,
  replace = false,
): void {
  if (!isExpandedView) return;
  const url = new URL(window.location.href);
  if (!inspectModeActive && !target) {
    url.searchParams.delete("inspect");
    url.searchParams.delete("inspectTarget");
    url.searchParams.delete("badgeId");
  } else {
    url.searchParams.set("inspect", "1");
    if (!target) {
      url.searchParams.delete("inspectTarget");
      url.searchParams.delete("badgeId");
    } else if (target.kind === "elo") {
      url.searchParams.set("inspectTarget", "elo");
      url.searchParams.delete("badgeId");
    } else {
      url.searchParams.set("inspectTarget", "badge");
      url.searchParams.set("badgeId", target.badgeId);
    }
  }
  const method = replace ? window.history.replaceState : window.history.pushState;
  method.call(window.history, {}, "", `${url.pathname}${url.search}${url.hash}`);
}

function readStoredVoteSnapshot(): StoredVoteSnapshot | null {
  const key = voteStateStorageKey();
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredVoteSnapshot;
    if (!parsed || typeof parsed !== "object" || !parsed.votes) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistLocalVoteState(): void {
  const key = voteStateStorageKey();
  if (!key) return;
  try {
    const now = Date.now();
    const votes: StoredVoteSnapshot["votes"] = {};
    for (const [badgeId, graceUntil] of Object.entries(localVoteGraceUntil)) {
      const vote = userVotes[badgeId];
      if (!vote || graceUntil <= now) continue;
      votes[badgeId] = { vote, graceUntil };
    }
    if (!Object.keys(votes).length) {
      window.localStorage.removeItem(key);
      return;
    }
    const snapshot: StoredVoteSnapshot = {
      updatedAt: now,
      votes,
    };
    window.localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // ignore storage issues in embedded views
  }
}

function syncVotesFromStorage(): boolean {
  const snapshot = readStoredVoteSnapshot();
  if (!snapshot) return false;
  const now = Date.now();
  let changed = false;
  let hasActiveStoredVote = false;
  for (const [badgeId, stored] of Object.entries(snapshot.votes)) {
    if (!stored || typeof stored.graceUntil !== "number") continue;
    if (stored.graceUntil <= now) continue;
    hasActiveStoredVote = true;
    if (userVotes[badgeId] !== stored.vote) {
      userVotes[badgeId] = stored.vote;
      changed = true;
    }
    if ((localVoteGraceUntil[badgeId] ?? 0) < stored.graceUntil) {
      localVoteGraceUntil[badgeId] = stored.graceUntil;
    }
  }
  if (!hasActiveStoredVote) {
    persistLocalVoteState();
  }
  return changed;
}

function readStoredImageIndex(totalImages: number): number | null {
  const key = pageStateStorageKey();
  if (!key) return null;
  try {
    const stored = Number(window.localStorage.getItem(key));
    if (Number.isFinite(stored)) {
      return Math.max(0, Math.min(totalImages - 1, Math.floor(stored)));
    }
  } catch {
    // ignore storage issues in embedded views
  }
  return null;
}

function readInitialImageIndex(totalImages: number): number {
  const storedIndex = readStoredImageIndex(totalImages);
  if (storedIndex !== null) {
    return storedIndex;
  }
  const queryPage = Number(query.get("page"));
  if (Number.isFinite(queryPage) && queryPage >= 1) {
    return Math.max(0, Math.min(totalImages - 1, Math.floor(queryPage - 1)));
  }
  return 0;
}

function persistActiveImageIndex(): void {
  if (!postData) return;
  try {
    const key = pageStateStorageKey();
    if (key) {
      if (
        key === lastPersistedPageKey &&
        activeImageIndex === lastPersistedPageIndex
      ) {
        return;
      }
      window.localStorage.setItem(key, String(activeImageIndex));
      lastPersistedPageKey = key;
      lastPersistedPageIndex = activeImageIndex;
    }
  } catch {
    // ignore history issues in embedded views
  }
}

function writeActiveImageIndexToStorage(): void {
  persistActiveImageIndex();
}

function finalizeCommittedPreview(): void {
  if (!committedPreviewImg && !committedPreviewBadges) return;
  cancelSwipeTransformFrame();
  canvasImg.style.transform = "";
  badgesEl.style.transform = "";
  canvasImg.style.visibility = "";
  badgesEl.style.visibility = "";
  committedPreviewImg?.remove();
  committedPreviewBadges?.remove();
  committedPreviewImg = null;
  committedPreviewBadges = null;
  lastBadgeLayoutKey = "";
  layoutBadges(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      canvasImg.style.transition = "";
      badgesEl.style.transition = "";
    });
  });
}

function clearCanvasDragTransform(): void {
  cancelSwipeTransformFrame();
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.transition = "";
  badgesEl.style.transition = "";
  canvasImg.style.transform = "";
  badgesEl.style.transform = "";
}

function clearSwipePreview(): void {
  pendingPreviewSwipeDx = null;
  swipePreviewImg?.remove();
  swipePreviewBadges?.remove();
  swipePreviewImg = null;
  swipePreviewBadges = null;
  swipePreviewIndex = null;
}

function translateXPx(px: number): string {
  return `translate3d(${px.toFixed(2)}px, 0, 0)`;
}

function cancelSwipeTransformFrame(): void {
  if (swipeTransformRaf !== null) {
    window.cancelAnimationFrame(swipeTransformRaf);
    swipeTransformRaf = null;
  }
}

function flushSwipeTransforms(): void {
  swipeTransformRaf = null;
  const activeTransform = translateXPx(pendingActiveSwipeDx);
  canvasImg.style.transform = activeTransform;
  badgesEl.style.transform = activeTransform;

  if (swipePreviewImg && pendingPreviewSwipeDx !== null) {
    swipePreviewImg.style.transform = translateXPx(pendingPreviewSwipeDx);
  }
  if (swipePreviewBadges && pendingPreviewSwipeDx !== null) {
    swipePreviewBadges.style.transform = translateXPx(pendingPreviewSwipeDx);
  }
}

function scheduleSwipeTransforms(
  activeDx: number,
  previewDx: number | null,
): void {
  pendingActiveSwipeDx = activeDx;
  pendingPreviewSwipeDx = previewDx;
  if (swipeTransformRaf !== null) return;
  swipeTransformRaf = window.requestAnimationFrame(flushSwipeTransforms);
}

function preloadImage(imageUrl: string): void {
  if (!imageUrl || imagePreloadCache.has(imageUrl)) return;
  const img = new Image();
  img.decoding = "async";
  img.src = imageUrl;
  imagePreloadCache.set(imageUrl, img);
}

function getOrCreatePreloadedImage(imageUrl: string): HTMLImageElement | null {
  if (!imageUrl) return null;
  const cached = imagePreloadCache.get(imageUrl);
  if (cached) return cached;
  const img = new Image();
  img.decoding = "async";
  img.src = imageUrl;
  imagePreloadCache.set(imageUrl, img);
  return img;
}

function onImageReady(img: HTMLImageElement, callback: () => void): void {
  if (img.complete) {
    if (typeof img.decode === "function") {
      void img
        .decode()
        .catch(() => undefined)
        .finally(callback);
      return;
    }
    callback();
    return;
  }

  const handleReady = () => {
    img.removeEventListener("load", handleReady);
    img.removeEventListener("error", handleReady);
    callback();
  };

  img.addEventListener("load", handleReady, { once: true });
  img.addEventListener("error", handleReady, { once: true });
}

function preloadImageAtIndex(index: number): void {
  if (!postData) return;
  const image = postData.images[index];
  if (image) preloadImage(image.imageUrl);
}

function preloadNearbyImages(): void {
  if (!postData) return;
  preloadImageAtIndex(activeImageIndex);
  preloadImageAtIndex(activeImageIndex - 1);
  preloadImageAtIndex(activeImageIndex + 1);
  preloadImageAtIndex(activeImageIndex - 2);
  preloadImageAtIndex(activeImageIndex + 2);
}

function findCurrentImagePlacementById(
  badgeId: string | undefined,
): BadgePlacement | null {
  if (!badgeId) return null;
  return (
    currentImage()?.placements.find((placement) => placement.id === badgeId) ??
    null
  );
}

function applyImageIndexImmediately(nextIndex: number): void {
  if (!postData) return;
  const clampedIndex = Math.max(
    0,
    Math.min(postData.images.length - 1, nextIndex),
  );
  activeImageIndex = clampedIndex;
  navTransitionInFlight = false;
  queuedNavIndex = null;
  imageSlideDirection = null;
  pendingSlideSnapshot = null;
  imageLoadToken += 1;
  clearSwipePreview();
  finalizeCommittedPreview();
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.transition = "none";
  badgesEl.style.transition = "none";
  canvasImg.style.transform = translateXPx(0);
  badgesEl.style.transform = translateXPx(0);
  canvasImg.style.visibility = "";
  badgesEl.style.visibility = "";
  const image = currentImage();
  if (image) {
    const cached = imagePreloadCache.get(image.imageUrl);
    canvasImg.src = cached?.currentSrc || cached?.src || image.imageUrl;
  }
  updateImageNav();
  preloadNearbyImages();
  lastBadgeLayoutKey = "";
  layoutBadges(true);
  requestAnimationFrame(() => {
    canvasImg.style.transition = "";
    badgesEl.style.transition = "";
    canvasImg.style.transform = "";
    badgesEl.style.transform = "";
    layoutBadges(true);
  });
}

function commitSwipeNavigation(nextIndex: number): void {
  if (!postData) return;
  const nextImage = postData.images[nextIndex];
  if (!nextImage) return;

  const previewImg = swipePreviewImg;
  const previewBadges = swipePreviewBadges;

  activeImageIndex = nextIndex;
  imageSlideDirection = null;
  pendingSlideSnapshot = null;
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.visibility = "hidden";
  badgesEl.style.visibility = "hidden";
  canvasImg.style.transition = "none";
  badgesEl.style.transition = "none";
  canvasImg.style.transform = translateXPx(0);
  badgesEl.style.transform = translateXPx(0);
  committedPreviewImg = previewImg;
  committedPreviewBadges = previewBadges;
  if (previewImg) {
    canvasImg.src =
      previewImg.currentSrc || previewImg.src || nextImage.imageUrl;
  } else {
    canvasImg.src = nextImage.imageUrl;
  }
  if (previewBadges) {
    badgesEl.style.left = previewBadges.style.left;
    badgesEl.style.top = previewBadges.style.top;
    badgesEl.style.width = previewBadges.style.width;
    badgesEl.style.height = previewBadges.style.height;
    badgesEl.innerHTML = previewBadges.innerHTML;
    applyBadgeVisibility();
  }
  updateImageNav();
  preloadNearbyImages();
  swipePreviewImg = null;
  swipePreviewBadges = null;
  swipePreviewIndex = null;
  if (canvasImg.complete && canvasImg.naturalWidth > 0) {
    requestAnimationFrame(() => {
      finalizeCommittedPreview();
    });
  } else {
    window.setTimeout(() => {
      finalizeCommittedPreview();
    }, 260);
  }
}

function finishSwipeNavigation(nextIndex: number, dx: number): void {
  if (!swipePreviewImg || !swipePreviewBadges) {
    commitSwipeNavigation(nextIndex);
    return;
  }
  cancelSwipeTransformFrame();
  const travelPx = Math.max(
    1,
    canvasEl.clientWidth || canvasEl.getBoundingClientRect().width || 1,
  );
  const outgoingToX = dx < 0 ? -travelPx : travelPx;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

  canvasImg.style.transition = `transform ${SWIPE_SETTLE_DURATION_MS}ms ${easing}`;
  badgesEl.style.transition = `transform ${SWIPE_SETTLE_DURATION_MS}ms ${easing}`;
  swipePreviewImg.style.transition = `transform ${SWIPE_SETTLE_DURATION_MS}ms ${easing}`;
  swipePreviewBadges.style.transition = `transform ${SWIPE_SETTLE_DURATION_MS}ms ${easing}`;

  requestAnimationFrame(() => {
    canvasImg.style.transform = translateXPx(outgoingToX);
    badgesEl.style.transform = translateXPx(outgoingToX);
    swipePreviewImg!.style.transform = translateXPx(0);
    swipePreviewBadges!.style.transform = translateXPx(0);
  });

  window.setTimeout(() => {
    commitSwipeNavigation(nextIndex);
  }, SWIPE_SETTLE_DURATION_MS + 20);
}

function animateCanvasDragReset(): void {
  cancelSwipeTransformFrame();
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.transition = `transform ${SWIPE_RESET_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  badgesEl.style.transition = `transform ${SWIPE_RESET_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  canvasImg.style.transform = translateXPx(0);
  badgesEl.style.transform = translateXPx(0);
  window.setTimeout(() => {
    canvasImg.style.transition = "";
    badgesEl.style.transition = "";
    canvasImg.style.transform = "";
    badgesEl.style.transform = "";
  }, SWIPE_RESET_DURATION_MS + 40);
}

function ensureSwipePreview(targetIndex: number, dx: number): boolean {
  if (!postData) return false;
  if (targetIndex < 0 || targetIndex >= postData.images.length) {
    clearSwipePreview();
    return false;
  }

  if (
    swipePreviewIndex !== targetIndex ||
    !swipePreviewImg ||
    !swipePreviewBadges
  ) {
    clearSwipePreview();
    const previewImage = postData.images[targetIndex];
    if (!previewImage) return false;

    const r = getCanvasRectForImage(previewImage);
    if (r.w <= 0 || r.h <= 0) return false;
    const scaleBase = markerScaleBase(r);

    swipePreviewIndex = targetIndex;
    swipePreviewImg = document.createElement("img");
    swipePreviewImg.className = "canvas-img canvas-preview";
    const cached = imagePreloadCache.get(previewImage.imageUrl);
    swipePreviewImg.src =
      cached?.currentSrc || cached?.src || previewImage.imageUrl;
    swipePreviewImg.style.position = "absolute";
    swipePreviewImg.style.inset = "0";
    swipePreviewImg.style.zIndex = "2";
    swipePreviewImg.style.pointerEvents = "none";

    swipePreviewBadges = document.createElement("div");
    swipePreviewBadges.className = "badges badges--preview";
    swipePreviewBadges.style.left = `${r.x}px`;
    swipePreviewBadges.style.top = `${r.y}px`;
    swipePreviewBadges.style.width = `${r.w}px`;
    swipePreviewBadges.style.height = `${r.h}px`;
    swipePreviewBadges.style.zIndex = "3";
    swipePreviewBadges.style.pointerEvents = "none";
    renderBadgesInto(swipePreviewBadges, previewImage, scaleBase, false);

    canvasEl.appendChild(swipePreviewImg);
    canvasEl.appendChild(swipePreviewBadges);
  }

  const travelPx = Math.max(
    1,
    canvasEl.clientWidth || canvasEl.getBoundingClientRect().width || 1,
  );
  const baseOffset = targetIndex > activeImageIndex ? travelPx : -travelPx;
  const previewX = baseOffset + dx;
  if (swipePreviewImg) {
    swipePreviewImg.style.transition = "none";
  }
  if (swipePreviewBadges) {
    swipePreviewBadges.style.transition = "none";
  }
  scheduleSwipeTransforms(dx, previewX);
  return true;
}

function syncActiveImageIndexFromStorage(): void {
  if (!postData || navTransitionInFlight || isExpandedView) return;
  const nextIndex = readStoredImageIndex(postData.images.length);
  if (nextIndex === null || nextIndex === activeImageIndex) return;
  applyImageIndexImmediately(nextIndex);
}

function syncTransientStateFromStorage(): void {
  if (!postData) return;
  const imageIndexBefore = activeImageIndex;
  syncActiveImageIndexFromStorage();
  const votesChanged = syncVotesFromStorage();
  if (votesChanged || imageIndexBefore !== activeImageIndex) {
    layoutBadges(true);
  }
}

function openMenu(): void {
  menuDropdownEl.classList.remove("hidden");
}

function closeMenu(): void {
  menuDropdownEl.classList.add("hidden");
}

function toggleMenu(): void {
  if (menuDropdownEl.classList.contains("hidden")) openMenu();
  else closeMenu();
}

function openInspector(): void {
  inspectorOvl.classList.add("open");
  inspectorOvl.classList.remove("hidden");
}

function closeInspector(): void {
  inspectorOvl.classList.remove("open");
  inspectorOvl.classList.add("hidden");
}

menuToggleBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleMenu();
});

menuInfoBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const wikiUrl = subredditWikiUrl();
  if (!wikiUrl) {
    showToast("Subreddit wiki unavailable");
    return;
  }
  navigateExternal(wikiUrl);
});

menuCreateBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  openCreateFlow(event);
});

menuEditBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  openEditFlow(event);
});

menuInspectBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  openInspectFlow(event);
});

inspectorBg.addEventListener("click", () => {
  if (inspectModeActive && inspectDetailTarget) {
    window.history.back();
    return;
  }
  closeInspector();
});

inspectorCloseBtn.addEventListener("click", (event) => {
  event.preventDefault();
  if (inspectModeActive && inspectDetailTarget) {
    window.history.back();
    return;
  }
  closeInspector();
});

inspectEloBtn.addEventListener("click", (event) => {
  event.preventDefault();
  void openInspectDetail({ kind: "elo" }).catch((error) => {
    showToast(error instanceof Error ? error.message : "Failed to load vote breakdown");
  });
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (!target.closest(".post-menu") && !menuDropdownEl.classList.contains("hidden")) {
    closeMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
    if (inspectModeActive && inspectDetailTarget) {
      window.history.back();
    } else if (inspectModeActive) {
      exitInspectMode();
    } else {
      closeInspector();
    }
  }
});

window.addEventListener("popstate", () => {
  if (!isExpandedView || !viewerIsModerator) return;
  const nextTarget = readInspectTargetFromLocation();
  const params = new URLSearchParams(window.location.search);
  const wantsInspect = params.get("inspect") === "1";
  if (!wantsInspect) {
    exitInspectMode(false);
    return;
  }
  inspectModeActive = true;
  updateInspectChrome();
  if (!nextTarget) {
    openInspectRoot(true);
    return;
  }
  void openInspectDetail(nextTarget, false).catch((error) => {
    showToast(error instanceof Error ? error.message : "Failed to load vote breakdown");
  });
});

function resetPostTransientOverlays(): void {
  pickerOvl.classList.remove("open");
  voteHintEl.classList.add("hidden");
  closeMenu();
  closeInspector();
}

function shouldShowVoteHint(): boolean {
  return isExpandedView && canVoteOnCurrentPost() && !hasEverSubmittedBadgeVote;
}

function openVoteHint(): void {
  if (!shouldShowVoteHint()) return;
  voteHintEl.classList.remove("hidden");
}

function closeVoteHint(): void {
  voteHintEl.classList.add("hidden");
}

resetPostTransientOverlays();
window.addEventListener("pageshow", () => {
  resetPostTransientOverlays();
  syncTransientStateFromStorage();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isExpandedView) {
    writeActiveImageIndexToStorage();
    persistLocalVoteState();
  }
  if (document.visibilityState === "visible") {
    resetPostTransientOverlays();
    syncTransientStateFromStorage();
  }
});
window.addEventListener("focus", () => {
  resetPostTransientOverlays();
  syncTransientStateFromStorage();
});
window.addEventListener("pagehide", () => {
  if (isExpandedView) {
    writeActiveImageIndexToStorage();
    persistLocalVoteState();
  }
});
window.addEventListener("storage", (event) => {
  if (event.key !== voteStateStorageKey()) return;
  syncTransientStateFromStorage();
});

async function fetchInitWithTimeout(timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(ApiEndpoint.Init, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function startLoadingIndicator(): void {
  stopLoadingIndicator();
  const show = () => {
    loadingIndicatorTimer = null;
    loadingEl.style.display = "flex";
    loadingIndicatorShownAt = Date.now();
    loadingEl.classList.add("is-visible");
  };

  if (isExpandedView) {
    show();
    return;
  }

  loadingEl.style.display = "none";
  loadingIndicatorShownAt = 0;
  loadingEl.classList.remove("is-visible");
  loadingIndicatorTimer = window.setTimeout(
    show,
    LOADING_INDICATOR_SHOW_DELAY_MS_COMPACT,
  );
}

function stopLoadingIndicator(): void {
  if (loadingIndicatorTimer !== null) {
    window.clearTimeout(loadingIndicatorTimer);
    loadingIndicatorTimer = null;
  }
  if (loadingIndicatorHideTimer !== null) {
    window.clearTimeout(loadingIndicatorHideTimer);
    loadingIndicatorHideTimer = null;
  }

  if (!loadingEl.classList.contains("is-visible")) {
    loadingIndicatorShownAt = 0;
    loadingEl.classList.remove("is-visible");
    loadingEl.style.display = "none";
    return;
  }

  const elapsedVisibleMs = loadingIndicatorShownAt
    ? Date.now() - loadingIndicatorShownAt
    : LOADING_INDICATOR_MIN_VISIBLE_MS;
  const remainingVisibleMs = Math.max(
    0,
    LOADING_INDICATOR_MIN_VISIBLE_MS - elapsedVisibleMs,
  );

  const hide = () => {
    loadingIndicatorShownAt = 0;
    loadingIndicatorHideTimer = null;
    loadingEl.classList.remove("is-visible");
    loadingEl.style.display = "none";
  };

  if (remainingVisibleMs === 0) {
    hide();
    return;
  }

  loadingIndicatorHideTimer = window.setTimeout(hide, remainingVisibleMs);
}

function beginInitialPostReveal(): void {
  postEl.style.display = "flex";
  postEl.classList.remove("is-ready");
}

function completeInitialPostReveal(): void {
  postEl.classList.add("is-ready");
  stopLoadingIndicator();
}

function schedulePostLayoutRefresh(): void {
  if (postLayoutRaf !== null) return;
  postLayoutRaf = window.requestAnimationFrame(() => {
    postLayoutRaf = null;
    layoutBadges(true);
    applyEloTrackVisuals();
    updateGmTickPosition();
  });
}

function badgeAsset(vote: BadgeVoteOption): string {
  return `/assets/badges/${vote.toLowerCase()}.png`;
}

function unknownBadgeAsset(): string {
  return "/assets/badges/unknown.png";
}

function ringPhaseDelaySeconds(): number {
  const nowMs =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  return -((nowMs % 1800) / 1000);
}

function getPickerClassifications(bookValid: boolean): Classification[] {
  return [
    Classification.BRILLIANT,
    Classification.GREAT,
    Classification.BEST,
    Classification.EXCELLENT,
    Classification.GOOD,
    bookValid ? Classification.BOOK : Classification.FORCED,
    Classification.INACCURACY,
    Classification.MISTAKE,
    Classification.MISS,
    Classification.BLUNDER,
  ];
}

function getSortedPlacements(): BadgePlacement[] {
  return (postData?.images ?? [])
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function isResultVoteAvailableForBadge(p: BadgePlacement): boolean {
  const sorted = getSortedPlacements();
  if (sorted.length <= 1) return false;
  const lastPlacement = sorted[sorted.length - 1];
  return lastPlacement?.id === p.id;
}

function getVoteOptionInfo(vote: BadgeVoteOption): { label: string } {
  return isResultVote(vote) ? RESULT_INFO[vote] : BADGE_INFO[vote];
}

function getVoteOptionHint(vote: BadgeVoteOption): string | undefined {
  return isResultVote(vote) ? RESULT_HINTS[vote] : BADGE_HINTS[vote];
}

function playRecentVoteAnimation(
  faceEl: HTMLDivElement | null,
  voteEl: HTMLDivElement | null,
): void {
  if (faceEl) {
    faceEl.style.transition = "none";
    faceEl.style.transform = "scale(0.92)";
    faceEl.style.opacity = "0.82";
    void faceEl.offsetWidth;
    requestAnimationFrame(() => {
      faceEl.style.transition =
        "transform 340ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 340ms cubic-bezier(0.2, 0.9, 0.2, 1)";
      faceEl.style.transform = "scale(1)";
      faceEl.style.opacity = "1";
      window.setTimeout(() => {
        faceEl.style.transition = "";
        faceEl.style.transform = "";
        faceEl.style.opacity = "";
      }, 380);
    });
  }

  if (voteEl) {
    voteEl.style.transition = "none";
    voteEl.style.transform = "translate(12%, 12%) scale(0.56)";
    voteEl.style.opacity = "0.35";
    void voteEl.offsetWidth;
    requestAnimationFrame(() => {
      voteEl.style.transition =
        "transform 420ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 420ms cubic-bezier(0.2, 0.9, 0.2, 1)";
      voteEl.style.transform = "translate(12%, 12%) scale(1)";
      voteEl.style.opacity = "1";
      window.setTimeout(() => {
        voteEl.style.transition = "";
        voteEl.style.transform = "translate(12%, 12%)";
        voteEl.style.opacity = "";
      }, 460);
    });
  }
}

function playBadgeTapAnimation(badgeEl: HTMLDivElement): void {
  badgeEl.style.transition = "none";
  badgeEl.style.transform = "translate(-50%, -50%) scale(0.93)";
  void badgeEl.offsetWidth;
  requestAnimationFrame(() => {
    badgeEl.style.transition = "transform 170ms cubic-bezier(0.2, 0.9, 0.2, 1)";
    badgeEl.style.transform = "translate(-50%, -50%) scale(1)";
    window.setTimeout(() => {
      badgeEl.style.transition = "";
      badgeEl.style.transform = "translate(-50%, -50%)";
    }, 210);
  });
}

function scheduleRecentVoteAnimation(badgeId: string): void {
  const animationToken = recentVoteAnimationUntil[badgeId] ?? 0;
  if (animationToken <= Date.now()) return;
  delete recentVoteAnimationUntil[badgeId];
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const badgeEl = badgesEl.querySelector(
        `.badge[data-badge-id="${badgeId}"]`,
      ) as HTMLDivElement | null;
      if (!badgeEl) return;
      const faceEl = badgeEl.querySelector(
        ".badge-face",
      ) as HTMLDivElement | null;
      const voteEl = badgeEl.querySelector(
        ".badge-vote",
      ) as HTMLDivElement | null;
      playRecentVoteAnimation(faceEl, voteEl);
    });
  });
}

function applyBadgeVisibility(): void {
  badgesEl.classList.toggle("is-hidden", !badgesVisible);
  badgeVisToggleBtn.classList.toggle("is-off", !badgesVisible);
  badgeVisToggleBtn.textContent = "👁";
  badgeVisToggleBtn.setAttribute(
    "aria-label",
    badgesVisible ? "Hide badges" : "Show badges",
  );
}

function markUserInteraction(): void {
  lastUserInteractionAt = Date.now();
}

function buildBadgeLayoutKey(image: PostData["images"][number]): string {
  const placementsKey = image.placements
    .map((placement) => {
      const c = consensus[placement.id];
      const vote = userVotes[placement.id] ?? "";
      const consensusVote = c?.winningVote ?? "";
      const consensusTotal = c?.winningVotes ?? 0;
      return [
        placement.id,
        placement.x,
        placement.y,
        placement.radius,
        placement.classification ?? "",
        vote,
        consensusVote,
        consensusTotal,
        c?.winningCategory ?? "",
      ].join(":");
    })
    .join("|");
  return `${activeImageIndex}#${placementsKey}`;
}

function normalizePostData(data: PostData): PostData {
  if (Array.isArray(data.images) && data.images.length > 0) return data;
  if (data.imageUrl) {
    return {
      ...data,
      images: [{ imageUrl: data.imageUrl, placements: data.placements ?? [] }],
    };
  }
  return { ...data, images: [] };
}

function currentImage() {
  if (!postData) return null;
  return postData.images[activeImageIndex] ?? null;
}

function isOwnPost(): boolean {
  return viewerOwnsPost;
}

function isTouchPrimaryInput(): boolean {
  const userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches)
  );
}

function isAndroidLike(): boolean {
  const userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return /Android|Linux; arm|Linux; aarch64/i.test(userAgent);
}

function isVotingWindowOpen(): boolean {
  const createdAtMs = postData?.createdAtMs;
  if (!createdAtMs) return true;
  return Date.now() - createdAtMs <= MAX_POST_AGE_TO_VOTE_MS;
}

function canVoteOnCurrentPost(): boolean {
  return (
    viewerIsLoggedIn &&
    !!postData &&
    postData.mode === "vote" &&
    !isOwnPost() &&
    isVotingWindowOpen()
  );
}

function getVoteLockTimeLeftMs(): number | null {
  const createdAtMs = postData?.createdAtMs;
  if (!createdAtMs) return null;
  return Math.max(0, createdAtMs + MAX_POST_AGE_TO_VOTE_MS - Date.now());
}

function formatVoteLockCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 1) {
    return `${hours}h`;
  }
  if (minutes >= 1) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function clearVoteLockCountdownTimer(): void {
  if (voteLockCountdownTimer !== null) {
    window.clearInterval(voteLockCountdownTimer);
    voteLockCountdownTimer = null;
  }
}

function updateOwnPostVotingFooterText(): void {
  if (!eloLoginTextEl) return;
  const timeLeftMs = getVoteLockTimeLeftMs();
  if (timeLeftMs === null) {
    eloLoginTextEl.textContent = "Your post is being voted on";
    return;
  }
  eloLoginTextEl.textContent = `Your post is being voted on (${formatVoteLockCountdown(
    timeLeftMs,
  )} left)`;
}

function ensureVoteLockCountdownTimer(): void {
  updateOwnPostVotingFooterText();
  if (voteLockCountdownTimer !== null) return;
  voteLockCountdownTimer = window.setInterval(() => {
    if (
      !postData ||
      postData.mode !== "vote" ||
      !isOwnPost() ||
      !isVotingWindowOpen()
    ) {
      clearVoteLockCountdownTimer();
      updateVoteFooter(false);
      return;
    }
    updateOwnPostVotingFooterText();
  }, 1000);
}

function clearEloBubbleHideTimer(): void {
  if (eloBubbleHideTimer !== null) {
    window.clearTimeout(eloBubbleHideTimer);
    eloBubbleHideTimer = null;
  }
}

function clearEloInteractionFailsafe(): void {
  if (eloInteractionFailsafeTimer !== null) {
    window.clearTimeout(eloInteractionFailsafeTimer);
    eloInteractionFailsafeTimer = null;
  }
}

function hideEloBubble(immediate = false): void {
  clearEloBubbleHideTimer();
  eloBubble.classList.remove("elo-bubble--active");
  if (immediate) {
    eloBubble.classList.remove("elo-bubble--visible");
    return;
  }
  eloBubbleHideTimer = window.setTimeout(() => {
    eloBubble.classList.remove("elo-bubble--visible");
    eloBubbleHideTimer = null;
  }, ELO_BUBBLE_HIDE_DELAY_MS);
}

function updateEloBubblePosition(): void {
  const min = Number(eloSlider.min) || MIN_ELO;
  const max = Number(eloSlider.max) || MAX_ELO;
  const value = Number(eloSlider.value);
  const trackWidth =
    eloSlider.clientWidth || eloSlider.getBoundingClientRect().width;
  if (trackWidth <= 0) return;

  const t = max > min ? (value - min) / (max - min) : 0;
  const thumbCenter =
    t * Math.max(0, trackWidth - ELO_THUMB_SIZE_PX) + ELO_THUMB_SIZE_PX / 2;
  const rawLeft = eloSlider.offsetLeft + thumbCenter;
  const bubbleHalf = Math.max(28, eloBubble.offsetWidth / 2 || 28);
  const wrapWidth = eloSlider.parentElement?.clientWidth ?? trackWidth;
  const bubbleOverhang = 6;
  const clampedLeft = Math.max(
    bubbleHalf - bubbleOverhang,
    Math.min(wrapWidth - bubbleHalf + bubbleOverhang, rawLeft),
  );
  const maxArrowOffset = Math.max(0, bubbleHalf - 18);
  const arrowOffset = Math.max(
    -maxArrowOffset,
    Math.min(maxArrowOffset, rawLeft - clampedLeft),
  );

  eloBubble.style.left = `${clampedLeft}px`;
  eloBubble.style.setProperty("--elo-bubble-arrow-offset", `${arrowOffset}px`);
}

function showEloBubble(active: boolean): void {
  if (Date.now() < suppressEloBubbleUntil) return;
  clearEloBubbleHideTimer();
  eloBubble.classList.add("elo-bubble--visible");
  eloBubble.classList.toggle("elo-bubble--active", active);
  updateEloBubblePosition();
}

function isEloInteractionActive(): boolean {
  return eloPointerId !== null || eloTouchId !== null;
}

function hideEloBubbleIfIdle(): void {
  if (isEloInteractionActive()) return;
  if (!eloBubble.classList.contains("elo-bubble--visible")) return;
  hideEloBubble();
}

function updateVoteFooter(initializeElo = false): void {
  if (
    !postData ||
    postData.mode !== "vote" ||
    isExpandedView ||
    inspectModeActive ||
    !isVotingWindowOpen()
  ) {
    clearVoteLockCountdownTimer();
    hideEloBubble(true);
    eloEl.style.display = "none";
    if (eloLoginEl) eloLoginEl.style.display = "none";
    return;
  }

  if (isOwnPost()) {
    clearVoteLockCountdownTimer();
    hideEloBubble(true);
    eloEl.style.display = "none";
    ensureVoteLockCountdownTimer();
    if (eloLoginEl) eloLoginEl.style.display = "flex";
    return;
  }

  if (!viewerIsLoggedIn) {
    clearVoteLockCountdownTimer();
    hideEloBubble(true);
    eloEl.style.display = "none";
    if (eloLoginTextEl) {
      eloLoginTextEl.textContent = "Log in to vote";
    }
    if (eloLoginEl) eloLoginEl.style.display = "flex";
    return;
  }

  clearVoteLockCountdownTimer();
  if (eloLoginEl) eloLoginEl.style.display = "none";
  if (canVoteOnCurrentPost()) {
    eloEl.style.display = "";
    if (initializeElo) {
      setupElo();
    } else {
      applyEloTrackVisuals();
      updateEloDisplay();
      updateGmTickPosition();
    }
  } else {
    hideEloBubble(true);
    eloEl.style.display = "none";
  }
}

function getCanvasRect() {
  const image = currentImage();
  if (image) {
    return getCanvasRectForImage(image);
  }
  const canvasRect = canvasEl.getBoundingClientRect();
  return getCanvasRectForDimensions(
    canvasRect.width,
    canvasRect.height,
    canvasImg.naturalWidth || canvasImg.width || 0,
    canvasImg.naturalHeight || canvasImg.height || 0,
  );
}

function getCanvasRectForImage(image: PostData["images"][number]) {
  const canvasRect = canvasEl.getBoundingClientRect();
  return getCanvasRectForDimensions(
    canvasRect.width,
    canvasRect.height,
    image.imageWidth ||
      imagePreloadCache.get(image.imageUrl)?.naturalWidth ||
      0,
    image.imageHeight ||
      imagePreloadCache.get(image.imageUrl)?.naturalHeight ||
      0,
  );
}

function getCanvasRectForDimensions(
  boxW: number,
  boxH: number,
  naturalW: number,
  naturalH: number,
) {
  if (boxW <= 0 || boxH <= 0 || naturalW <= 0 || naturalH <= 0) {
    return {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      imgW: 0,
      imgH: 0,
    };
  }

  const scale = Math.min(boxW / naturalW, boxH / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  const imgX = (boxW - w) / 2;
  const imgY = (boxH - h) / 2;

  if (w <= 0 || h <= 0) {
    return {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      imgW: 0,
      imgH: 0,
    };
  }

  return {
    x: imgX,
    y: imgY,
    w,
    h,
    imgW: w,
    imgH: h,
  };
}

function markerScaleBase(rect: ReturnType<typeof getCanvasRect>): number {
  return Math.max(rect.imgW, rect.imgH);
}

function eloGradientCSS(trackWidthPx: number): string {
  const width = Math.max(1, trackWidthPx);
  const leftPadPx = ELO_THUMB_SIZE_PX / 2;
  const usablePx = Math.max(1, width - ELO_THUMB_SIZE_PX);
  const step = 10;
  const stops: string[] = [];
  const titledThreshold = 2200;

  const minColor = getEloColor(MIN_ELO);
  const maxColor = getEloColor(MAX_ELO);
  stops.push(`${minColor} 0%`);

  for (let elo = MIN_ELO; elo < titledThreshold; elo += step) {
    const t = (elo - MIN_ELO) / (MAX_ELO - MIN_ELO);
    const xPx = leftPadPx + t * usablePx;
    const pct = (xPx / width) * 100;
    stops.push(`${getEloColor(elo)} ${pct.toFixed(2)}%`);
  }

  const thresholdT = (titledThreshold - MIN_ELO) / (MAX_ELO - MIN_ELO);
  const thresholdXPx = leftPadPx + thresholdT * usablePx;
  const thresholdPct = (thresholdXPx / width) * 100;
  stops.push(`${getEloColor(titledThreshold - 1)} ${thresholdPct.toFixed(2)}%`);
  stops.push(`${getEloColor(titledThreshold)} ${thresholdPct.toFixed(2)}%`);

  for (let elo = titledThreshold + step; elo <= MAX_ELO; elo += step) {
    const t = (elo - MIN_ELO) / (MAX_ELO - MIN_ELO);
    const xPx = leftPadPx + t * usablePx;
    const pct = (xPx / width) * 100;
    stops.push(`${getEloColor(elo)} ${pct.toFixed(2)}%`);
  }

  if ((MAX_ELO - MIN_ELO) % step !== 0) {
    const xPx = leftPadPx + usablePx;
    const pct = (xPx / width) * 100;
    stops.push(`${maxColor} ${pct.toFixed(2)}%`);
  }

  stops.push(`${maxColor} 100%`);

  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function applyEloTrackVisuals(): void {
  const width = Math.max(
    1,
    Math.round(
      eloSlider.clientWidth || eloSlider.getBoundingClientRect().width || 0,
    ),
  );
  eloSlider.style.background = eloGradientCSS(width);
}

async function init() {
  startLoadingIndicator();
  try {
    let res: Response;
    if (isExpandedView) {
      try {
        res = await fetchInitWithTimeout(9000);
      } catch {
        res = await fetchInitWithTimeout(12000);
      }
    } else {
      res = await fetchInitWithTimeout(10000);
    }
    if (!res.ok) {
      throw new Error(`Init failed with ${res.status}`);
    }

    const data = (await res.json()) as InitResponse;

    postData = data.postData ? normalizePostData(data.postData) : null;
    currentPostId = data.postId;
    viewerOwnsPost = !!data.isOwnPost;
    consensus = data.consensus;
    userVotes = data.userVotes;
    syncVotesFromStorage();
    userElo = data.userElo;
    lastSubmittedElo = userElo;
    viewerUserId = data.userId;
    viewerIsLoggedIn = !!data.userId;
    viewerIsModerator = !!data.isModerator;
    hasEverSubmittedBadgeVote = !!data.hasEverSubmittedBadgeVote;
    currentSubredditName = data.subredditName ?? null;
    inspectData = null;

    menuEditBtn.classList.toggle("hidden", !viewerIsModerator || !postData);
    menuInspectBtn.classList.toggle("hidden", !viewerIsModerator || !postData);
    if (isExpandedView) {
      postMenuEl.style.display = "none";
    }

    if (!postData) {
      postEl.classList.remove("is-ready");
      postEl.style.display = "none";
      stopLoadingIndicator();
      createPrompt.style.display = "flex";
      createBtn.addEventListener("click", (event) => {
        try {
          requestExpandedMode(event as unknown as MouseEvent, "create");
        } catch {
          window.location.href = "/app.html";
        }
      });
      return;
    }

    createPrompt.style.display = "none";
    beginInitialPostReveal();
    activeImageIndex = readInitialImageIndex(postData.images.length);
    badgeVisToggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      badgesVisible = !badgesVisible;
      applyBadgeVisibility();
    });
    if (!BADGE_VISIBILITY_TOGGLE_ENABLED) {
      badgeVisToggleBtn.style.display = "none";
    }
    applyBadgeVisibility();
    if (isExpandedView) {
      badgeVisToggleBtn.style.display = "none";
    }

    if (postData.images.length > 1) imageNav.style.display = "flex";
    updateImageNav();
    preloadNearbyImages();
    loadCurrentImage(false);
    updateVoteFooter(true);
    completeInitialPostReveal();
    if (isExpandedView && viewerIsModerator) {
      const shouldOpenInspect =
        new URLSearchParams(window.location.search).get("inspect") === "1" ||
        consumeExpandedInspectIntent();
      if (shouldOpenInspect) {
        const initialTarget = readInspectTargetFromLocation();
        if (initialTarget) {
          inspectModeActive = true;
          updateInspectChrome();
          updateVoteFooter(false);
          await openInspectDetail(initialTarget, false);
        } else {
          openInspectRoot(true);
          try {
            await ensureInspectData();
          } catch (error) {
            showToast(
              error instanceof Error
                ? error.message
                : "Failed to load vote breakdown",
            );
          }
        }
      }
    }
    if (shouldShowVoteHint()) {
      window.setTimeout(() => {
        if (shouldShowVoteHint()) openVoteHint();
      }, 180);
    }

    if (refreshTimer === null && isExpandedView) {
      const refreshMs = 6000;
      refreshTimer = window.setInterval(() => {
        void refreshPostState();
      }, refreshMs);
      window.addEventListener("beforeunload", () => {
        if (refreshTimer !== null) {
          window.clearInterval(refreshTimer);
          refreshTimer = null;
        }
        clearVoteLockCountdownTimer();
      });
    }
  } catch (err) {
    console.error("Init failed:", err);
    postEl.classList.remove("is-ready");
    postEl.style.display = "none";
    stopLoadingIndicator();
    createPrompt.style.display = "flex";
    const titleEl = createPrompt.querySelector(
      ".create-title",
    ) as HTMLDivElement | null;
    const descEl = createPrompt.querySelector(
      ".create-desc",
    ) as HTMLDivElement | null;
    if (titleEl) titleEl.textContent = "Post unavailable";
    if (descEl) {
      descEl.textContent = "Load failed. Tap retry.";
    }
    createBtn.textContent = "Retry";
    createBtn.onclick = () => window.location.reload();
  }
}

async function refreshPostState(force = false) {
  if (!postData || document.hidden) return;
  if (!force && pickerOvl.classList.contains("open")) return;
  if (!force && inspectModeActive) return;
  if (!force && !inspectorOvl.classList.contains("hidden")) return;
  if (!force && Date.now() - lastUserInteractionAt < 900) return;
  if (!force && Date.now() < suppressRefreshUntil) return;
  try {
    const currentImageUrl = currentImage()?.imageUrl ?? null;
    const res = await fetch(ApiEndpoint.Init);
    if (!res.ok) return;
    const data = (await res.json()) as InitResponse;
    if (!data.postData) return;
    if (!force && Date.now() < suppressRefreshUntil) return;

    postData = normalizePostData(data.postData);
    currentPostId = data.postId;
  currentSubredditName = data.subredditName ?? null;
    viewerOwnsPost = !!data.isOwnPost;
    consensus = data.consensus;
    const now = Date.now();
    const nextVotes: Record<string, BadgeVoteOption> = { ...data.userVotes };
    for (const [badgeId, cls] of Object.entries(userVotes)) {
      const graceUntil = localVoteGraceUntil[badgeId] ?? 0;
      if (!nextVotes[badgeId] && now < graceUntil) {
        nextVotes[badgeId] = cls;
      }
      if (nextVotes[badgeId] === cls) {
        delete localVoteGraceUntil[badgeId];
      }
    }
    userVotes = nextVotes;
    syncVotesFromStorage();
    persistLocalVoteState();
    userElo = data.userElo;
    lastSubmittedElo = userElo;

    if (activeImageIndex >= postData.images.length) {
      activeImageIndex = Math.max(0, postData.images.length - 1);
    }

    updateVoteFooter(false);

    updateImageNav();
    preloadNearbyImages();
    const nextImageUrl = currentImage()?.imageUrl ?? null;
    if (nextImageUrl && nextImageUrl !== currentImageUrl) {
      loadCurrentImage(false);
    } else {
      layoutBadges();
    }
  } catch {
    // best-effort refresh
  }
}

function loadCurrentImage(animate = true) {
  const image = currentImage();
  if (!image) return;
  lastBadgeLayoutKey = "";
  const directionForAnimation = imageSlideDirection;
  const snapshotForAnimation = pendingSlideSnapshot;
  pendingSlideSnapshot = null;
  const shouldAnimate =
    animate &&
    !!directionForAnimation &&
    !!canvasImg.src &&
    !!postData &&
    postData.images.length > 1;

  const token = ++imageLoadToken;

  const finalizeLoadedImage = () => {
    if (token !== imageLoadToken) return;
    canvasImg.src = image.imageUrl;
    preloadNearbyImages();
    layoutBadges(true);
    if (shouldAnimate && directionForAnimation) {
      playSlideAnimation(directionForAnimation, snapshotForAnimation);
    } else {
      requestAnimationFrame(() => {
        if (token !== imageLoadToken) return;
        layoutBadges(true);
        completeNavigationTransition();
      });
    }
    imageSlideDirection = null;
  };

  const imageUrl = image.imageUrl;
  const currentUrl = canvasImg.currentSrc || canvasImg.src;
  if (currentUrl && currentUrl === imageUrl) {
    finalizeLoadedImage();
    return;
  }

  const preloader = getOrCreatePreloadedImage(imageUrl);
  if (!preloader) {
    finalizeLoadedImage();
    return;
  }
  onImageReady(preloader, finalizeLoadedImage);
}

function playSlideAnimation(
  direction: "prev" | "next",
  snapshot: {
    imageSrc: string;
    badgesHtml: string;
    badgesLeft: string;
    badgesTop: string;
    badgesWidth: string;
    badgesHeight: string;
  } | null,
): void {
  const travelPx = Math.max(
    1,
    canvasEl.clientWidth || canvasEl.getBoundingClientRect().width || 1,
  );
  const incomingFromX = direction === "next" ? travelPx : -travelPx;
  const outgoingToX = direction === "next" ? -travelPx : travelPx;
  const durationMs = PAGE_SLIDE_DURATION_MS;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

  let ghostImg: HTMLImageElement | null = null;
  let ghostBadges: HTMLDivElement | null = null;

  if (snapshot?.imageSrc) {
    ghostImg = document.createElement("img");
    ghostImg.className = "canvas-img";
    ghostImg.src = snapshot.imageSrc;
    ghostImg.style.position = "absolute";
    ghostImg.style.inset = "0";
    ghostImg.style.zIndex = "2";
    ghostImg.style.transform = "translateX(0)";
    ghostImg.style.pointerEvents = "none";

    ghostBadges = document.createElement("div");
    ghostBadges.className = "badges badges--ghost";
    ghostBadges.style.left = snapshot.badgesLeft;
    ghostBadges.style.top = snapshot.badgesTop;
    ghostBadges.style.width = snapshot.badgesWidth;
    ghostBadges.style.height = snapshot.badgesHeight;
    ghostBadges.style.zIndex = "3";
    ghostBadges.style.pointerEvents = "none";
    ghostBadges.innerHTML = snapshot.badgesHtml.replaceAll(
      "badge--ring",
      "badge--ring-ghost",
    );

    canvasEl.appendChild(ghostImg);
    canvasEl.appendChild(ghostBadges);
  }

  const incomingElements = [canvasImg, badgesEl];
  const outgoingElements: HTMLElement[] = [];
  if (ghostImg) outgoingElements.push(ghostImg);
  if (ghostBadges) outgoingElements.push(ghostBadges);

  for (const element of incomingElements) {
    element.style.transition = "none";
    element.style.transform = `translateX(${incomingFromX}px)`;
    void element.offsetWidth;
  }

  for (const element of outgoingElements) {
    element.style.transition = "none";
    element.style.transform = "translateX(0)";
    void element.offsetWidth;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const element of incomingElements) {
        element.style.transition = `transform ${durationMs}ms ${easing}`;
        element.style.transform = "translateX(0)";
      }
      for (const element of outgoingElements) {
        element.style.transition = `transform ${durationMs}ms ${easing}`;
        element.style.transform = `translateX(${outgoingToX}px)`;
      }
    });
  });

  window.setTimeout(() => {
    for (const element of incomingElements) {
      element.style.transition = "";
      element.style.transform = "";
    }
    ghostImg?.remove();
    ghostBadges?.remove();
    completeNavigationTransition();
  }, durationMs + 40);
}

function navigateToImage(nextIndex: number): void {
  if (!postData) return;
  if (
    nextIndex < 0 ||
    nextIndex >= postData.images.length ||
    nextIndex === activeImageIndex
  ) {
    return;
  }
  if (navTransitionInFlight) {
    queuedNavIndex = nextIndex;
    return;
  }
  startNavigationTo(nextIndex);
}

function startNavigationTo(nextIndex: number): void {
  navTransitionInFlight = true;

  pendingSlideSnapshot = {
    imageSrc: canvasImg.currentSrc || canvasImg.src,
    badgesHtml: badgesEl.innerHTML,
    badgesLeft: badgesEl.style.left,
    badgesTop: badgesEl.style.top,
    badgesWidth: badgesEl.style.width,
    badgesHeight: badgesEl.style.height,
  };

  imageSlideDirection = nextIndex > activeImageIndex ? "next" : "prev";
  activeImageIndex = nextIndex;
  markUserInteraction();
  updateImageNav();
  loadCurrentImage(true);
}

function completeNavigationTransition(): void {
  navTransitionInFlight = false;
  if (!postData) return;
  const queued = queuedNavIndex;
  queuedNavIndex = null;
  if (
    queued !== null &&
    queued !== activeImageIndex &&
    queued >= 0 &&
    queued < postData.images.length
  ) {
    startNavigationTo(queued);
  }
}

function updateImageNav() {
  if (!postData) return;
  const hasMultiple = postData.images.length > 1;
  const hideArrowsInAndroidFullscreen =
    hasMultiple && isExpandedView && isAndroidLike();
  pageChip.style.display = hasMultiple ? "block" : "none";
  pageChip.textContent = `${activeImageIndex + 1}/${postData.images.length}`;
  imgDots.innerHTML = "";
  const dotsFragment = document.createDocumentFragment();
  for (let index = 0; index < postData.images.length; index++) {
    const dot = document.createElement("div");
    dot.className = "img-dot";
    if (index === activeImageIndex) dot.classList.add("active");
    dotsFragment.appendChild(dot);
  }
  imgDots.appendChild(dotsFragment);
  imgPrev.style.display = hideArrowsInAndroidFullscreen
    ? "none"
    : hasMultiple
    ? "inline-flex"
    : "none";
  imgNext.style.display = hideArrowsInAndroidFullscreen
    ? "none"
    : hasMultiple
    ? "inline-flex"
    : "none";
  if (
    !hideArrowsInAndroidFullscreen &&
    hasMultiple &&
    isTouchPrimaryInput() &&
    !isAndroidLike()
  ) {
    imgPrev.style.display = "none";
    imgNext.style.display = "none";
  }
  imgPrev.disabled = !hasMultiple || activeImageIndex <= 0;
  imgNext.disabled =
    !hasMultiple || activeImageIndex >= postData.images.length - 1;
  persistActiveImageIndex();
}

imgPrev.addEventListener("click", () => {
  navigateToImage(activeImageIndex - 1);
});

imgNext.addEventListener("click", () => {
  if (!postData) return;
  navigateToImage(activeImageIndex + 1);
});

function openExpandedPost(event: Event): void {
  if (isExpandedView) return;
  const expandedUrl = `/post.html?expanded=1&page=${activeImageIndex + 1}`;
  writeActiveImageIndexToStorage();
  try {
    requestExpandedMode(event as unknown as MouseEvent, "expanded");
  } catch {
    window.location.href = expandedUrl;
  }
}

canvasEl.addEventListener("click", (event) => {
  if (isExpandedView) {
    return;
  }
  if (pickerOvl.classList.contains("open")) {
    return;
  }
  if (Date.now() < suppressCanvasClickUntil) {
    return;
  }
  if (Date.now() < suppressCanvasExpandUntil) {
    return;
  }
  const target = event.target as HTMLElement;
  const badgeClicksOpenExpanded =
    !!postData &&
    target.closest(".badge") &&
    !(postData.mode === "vote" && canVoteOnCurrentPost());
  if (
    (target.closest(".badge") && !badgeClicksOpenExpanded) ||
    target.closest(".img-nav-btn") ||
    target.closest(".post-menu") ||
    target.closest("#badge-vis-toggle") ||
    target.closest(".image-nav")
  ) {
    return;
  }
  openExpandedPost(event);
});

function layoutBadges(force = false) {
  if (!postData) return;
  const image = currentImage();
  if (!image) return;

  const nextLayoutKey = buildBadgeLayoutKey(image);
  if (!force && nextLayoutKey === lastBadgeLayoutKey) return;
  lastBadgeLayoutKey = nextLayoutKey;

  const r = getCanvasRectForImage(image);
  if (r.w <= 0 || r.h <= 0) {
    badgesEl.style.left = "0px";
    badgesEl.style.top = "0px";
    badgesEl.style.width = "0px";
    badgesEl.style.height = "0px";
    badgesEl.innerHTML = "";
    return;
  }
  const scaleBase = markerScaleBase(r);

  badgesEl.style.left = `${r.x}px`;
  badgesEl.style.top = `${r.y}px`;
  badgesEl.style.width = `${r.w}px`;
  badgesEl.style.height = `${r.h}px`;
  applyBadgeVisibility();
  renderBadgesInto(badgesEl, image, scaleBase, true);
}

function renderBadgesInto(
  container: HTMLDivElement,
  image: PostData["images"][number],
  scaleBase: number,
  interactive: boolean,
): void {
  if (!postData) return;
  const pd = postData;
  container.innerHTML = "";

  image.placements.forEach((p) => {
    const rad = p.radius || 3.5;
    const sizePx = ((rad * 2) / 100) * scaleBase;

    const el = document.createElement("div");
    el.className = "badge";
    el.dataset.badgeId = p.id;
    el.style.width = `${sizePx}px`;
    el.style.height = `${sizePx}px`;
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;

    const c = consensus[p.id];
    const uv = userVotes[p.id];
    const consensusVote = c?.winningVote ?? null;
    const hasConsensus =
      !!consensusVote &&
      (c?.winningVotes ?? 0) >= MIN_VOTES_FOR_BADGE_CONSENSUS;
    const isLiveVoteWindow = pd.mode === "vote" && isVotingWindowOpen();
    const opensExpandedOnTap =
      !isExpandedView && !(pd.mode === "vote" && canVoteOnCurrentPost());
    const opensInspectOnTap =
      inspectModeActive && isExpandedView && viewerIsModerator;
    let badgeImageUrl: string | null = null;
    let faceEl: HTMLDivElement | null = null;
    let voteEl: HTMLDivElement | null = null;

    if (opensExpandedOnTap) {
      el.classList.add("badge--passive");
    }

    if (pd.mode === "annotated" && p.classification) {
      el.classList.add("badge--voted");
      badgeImageUrl = badgeAsset(p.classification);
    } else {
      if (hasConsensus) {
        el.classList.add("badge--voted");
        badgeImageUrl = badgeAsset(consensusVote!);
      } else {
        el.classList.add("badge--placeholder");
        badgeImageUrl = unknownBadgeAsset();
      }

      if (badgeImageUrl) {
        faceEl = document.createElement("div");
        faceEl.className = "badge-face";
        if (isLiveVoteWindow) {
          faceEl.classList.add("badge-face--unlocked");
        }
        faceEl.style.backgroundImage = `url(${badgeImageUrl})`;
        el.appendChild(faceEl);
      }

      if (pd.mode === "vote") {
        if (!isLiveVoteWindow) {
          el.classList.add("badge--locked");
          el.style.pointerEvents = "none";
        }

        if (!uv && canVoteOnCurrentPost()) {
          el.classList.add("badge--ring");
          el.classList.add("badge--tappable");
          el.style.setProperty("--ring-delay", `${ringPhaseDelaySeconds()}s`);
          el.style.setProperty("--ring-width", `${UNVOTED_RING_WIDTH_PX}px`);
        }

        if (uv && !isOwnPost() && canVoteOnCurrentPost()) {
          voteEl = document.createElement("div");
          voteEl.className = "badge-vote";
          const voteSz = sizePx * 0.42;
          voteEl.style.width = `${voteSz}px`;
          voteEl.style.height = `${voteSz}px`;
          voteEl.style.backgroundImage = `url(${badgeAsset(uv)})`;
          el.appendChild(voteEl);
        }
      }
    }

    if (pd.mode === "annotated" && badgeImageUrl) {
      const faceEl = document.createElement("div");
      faceEl.className = "badge-face";
      faceEl.style.backgroundImage = `url(${badgeImageUrl})`;
      el.appendChild(faceEl);
    }

    if (interactive && opensInspectOnTap) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openInspectDetail({ kind: "badge", badgeId: p.id }).catch((error) => {
          showToast(error instanceof Error ? error.message : "Failed to load vote breakdown");
        });
      });
    } else if (interactive && pd.mode === "vote" && canVoteOnCurrentPost()) {
      el.addEventListener("pointerdown", (event) => {
        if (Date.now() < suppressPickerReopenUntil) {
          return;
        }
        if (event.button !== undefined && event.button !== 0) {
          return;
        }
        playBadgeTapAnimation(el);
      });
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() < suppressPickerReopenUntil) {
          return;
        }
        markUserInteraction();
        openPicker(p);
      });
    } else if (interactive && opensExpandedOnTap) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openExpandedPost(event);
      });
    }

    container.appendChild(el);
  });
}

window.addEventListener("resize", () => layoutBadges(true));

canvasImg.addEventListener("load", () => {
  finalizeCommittedPreview();
  schedulePostLayoutRefresh();
});

if (typeof ResizeObserver !== "undefined") {
  const postResizeObserver = new ResizeObserver(() => {
    schedulePostLayoutRefresh();
  });
  postResizeObserver.observe(canvasEl);
}

let activeHintEl: HTMLDivElement | null = null;

function isBookValidForVote(p: BadgePlacement): boolean {
  const sorted = getSortedPlacements();
  const idx = sorted.findIndex((b) => b.id === p.id);
  if (idx === 0) return true;
  const prev = sorted[idx - 1];
  if (!prev) return false;
  const prevVote = userVotes[prev.id];
  return prevVote === Classification.BOOK;
}

function openPicker(p: BadgePlacement) {
  if (!canVoteOnCurrentPost()) return;
  markUserInteraction();
  suppressCanvasExpandUntil = Date.now() + 900;
  lastPickerOpenAt = Date.now();
  const currentVote = userVotes[p.id];
  const resultVoteAvailable = isResultVoteAvailableForBadge(p);

  pickerTitle.textContent = resultVoteAvailable
    ? "Vote for Result (If the match is over)"
    : "Vote for Classification (Best → Worst)";
  pickerBody.innerHTML = "";
  activeHintEl = null;

  if (resultVoteAvailable) {
    const resultGrid = document.createElement("div");
    resultGrid.className = "pk-grid pk-grid--results";
    for (const result of RESULT_PICKER_OPTIONS) {
      resultGrid.appendChild(createPickerItem(result, currentVote, p, false));
    }
    pickerBody.appendChild(resultGrid);

    const classificationTitle = document.createElement("div");
    classificationTitle.className = "picker-title picker-title--section";
    classificationTitle.textContent = "Vote for Classification (Best → Worst)";
    pickerBody.appendChild(classificationTitle);
  }

  const grid = document.createElement("div");
  grid.className = "pk-grid";

  const bookValid = isBookValidForVote(p);

  for (const cls of getPickerClassifications(bookValid)) {
    const item = createPickerItem(cls, currentVote, p, false);
    grid.appendChild(item);
  }

  pickerBody.appendChild(grid);

  pickerOvl.classList.add("open");
}

function createPickerItem(
  cls: BadgeVoteOption,
  currentVote: BadgeVoteOption | undefined,
  p: BadgePlacement,
  disabled: boolean,
) {
  const info = getVoteOptionInfo(cls);
  const hint = getVoteOptionHint(cls);
  const item = document.createElement("div");
  item.className = "pk-item";
  if (currentVote === cls) item.classList.add("active");
  if (disabled) item.classList.add("disabled");

  const icon = document.createElement("div");
  icon.className = "pk-icon";
  icon.style.backgroundImage = `url(${badgeAsset(cls)})`;

  if (hint) {
    const hb = document.createElement("button");
    hb.type = "button";
    hb.className = "pk-hint-btn";
    hb.textContent = "?";
    hb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.classList.add("no-active");
    });
    hb.addEventListener("pointerup", (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.classList.remove("no-active");
    });
    hb.addEventListener("pointercancel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.classList.remove("no-active");
    });
    hb.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showHint(hb, hint);
    });
    icon.appendChild(hb);
  }
  item.appendChild(icon);

  const lbl = document.createElement("div");
  lbl.className = "pk-label";
  lbl.textContent = info.label;
  item.appendChild(lbl);

  item.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    markUserInteraction();
    if (disabled) return;
    lastPickerItemVoteAt = Date.now();
    voteBadge(p, cls);
  });
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    if (
      Date.now() - lastPickerItemVoteAt <
      PICKER_ITEM_CLICK_FALLBACK_GUARD_MS
    ) {
      return;
    }
    markUserInteraction();
    voteBadge(p, cls);
  });
  return item;
}

function showHint(trigger: HTMLElement, hintText: string) {
  if (activeHintEl) activeHintEl.remove();

  const popup = document.createElement("div");
  popup.className = "pk-hint-popup visible";
  popup.innerHTML = `<div>${hintText}</div>`;

  const arrow = document.createElement("div");
  arrow.className = "arrow";
  popup.appendChild(arrow);

  document.body.appendChild(popup);
  activeHintEl = popup;

  const tr = trigger.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();

  let left = tr.left + tr.width / 2 - pr.width / 2;
  if (left < 10) left = 10;
  if (left + pr.width > window.innerWidth - 10)
    left = window.innerWidth - pr.width - 10;

  popup.style.left = `${left}px`;
  popup.style.top = `${tr.top - pr.height - 8}px`;
  const arrowEl = popup.querySelector(".arrow") as HTMLDivElement | null;
  if (arrowEl) {
    const triggerCenter = tr.left + tr.width / 2;
    const arrowLeft = Math.max(
      10,
      Math.min(pr.width - 10, triggerCenter - left),
    );
    arrowEl.style.left = `${arrowLeft}px`;
    arrowEl.style.transform = "translateX(-50%)";
  }

  requestAnimationFrame(() => {
    document.addEventListener("click", closeHint, { once: true });
  });
}

function closeHint() {
  if (activeHintEl) {
    activeHintEl.remove();
    activeHintEl = null;
  }
}

function closePicker() {
  pickerOvl.classList.remove("open");
  const guardUntil = Date.now() + 220;
  suppressCanvasClickUntil = guardUntil;
  suppressCanvasExpandUntil = Math.max(suppressCanvasExpandUntil, guardUntil);
  swallowSyntheticReleaseClick = true;
  suppressSyntheticReleaseClickUntil = Math.max(
    suppressSyntheticReleaseClickUntil,
    Date.now() + 650,
  );
  markUserInteraction();
  closeHint();
}

function subredditWikiUrl(): string | null {
  if (!currentSubredditName) return null;
  return `https://www.reddit.com/r/${encodeURIComponent(currentSubredditName.toLowerCase())}/wiki/index/`;
}

function updateInspectChrome(): void {
  const showInspectFooter =
    inspectModeActive && isExpandedView && viewerIsModerator && !!postData;
  inspectFooterEl.classList.toggle("hidden", !showInspectFooter);
  document.body.classList.toggle("inspect-mode", showInspectFooter);
}

function exitInspectMode(updateHistory = true): void {
  inspectModeActive = false;
  inspectDetailTarget = null;
  closeInspector();
  updateInspectChrome();
  updateVoteFooter(false);
  if (updateHistory) {
    updateInspectLocation(null);
  }
}

function openInspectRoot(replaceHistory = false): void {
  inspectModeActive = true;
  inspectDetailTarget = null;
  closeInspector();
  updateInspectChrome();
  updateVoteFooter(false);
  updateInspectLocation(null, replaceHistory);
}

async function ensureInspectData(force = false): Promise<InspectVotesResponse> {
  if (inspectData && !force) {
    updateInspectChrome();
    return inspectData;
  }
  const token = ++inspectorReloadToken;
  const res = await fetch(ApiEndpoint.InspectVotes, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeUsers: true }),
  });
  if (token !== inspectorReloadToken) {
    return (
      inspectData ??
      ({ type: "inspect-votes", badgeVotes: {}, eloVotes: [] } satisfies InspectVotesResponse)
    );
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to load vote breakdown" }));
    throw new Error((err as { error?: string }).error ?? "Failed to load vote breakdown");
  }
  inspectData = (await res.json()) as InspectVotesResponse;
  updateInspectChrome();
  return inspectData;
}

function openCreateFlow(event?: Event): void {
  closeMenu();
  try {
    requestExpandedMode((event as unknown as MouseEvent) ?? new MouseEvent("click"), "create");
  } catch {
    window.location.href = "/app.html";
  }
}

function openEditFlow(event?: Event): void {
  closeMenu();
  try {
    requestExpandedMode((event as unknown as MouseEvent) ?? new MouseEvent("click"), "edit");
  } catch {
    window.location.href = "/app.html?mode=edit";
  }
}

function openInspectFlow(event?: Event): void {
  closeMenu();
  setExpandedInspectIntent();
  try {
    requestExpandedMode((event as unknown as MouseEvent) ?? new MouseEvent("click"), "expanded");
  } catch {
    window.location.href = "/post-expanded.html?inspect=1";
  }
}

function formatPreciseIqm(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toFixed(2);
}

function formatAccountAgeDays(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return "age n/a";
  if (days >= 365) {
    const years = days / 365;
    return `${years.toFixed(years >= 10 ? 0 : 1)}yr`;
  }
  if (days >= 30) {
    const months = days / 30;
    return `${months.toFixed(months >= 10 ? 0 : 1)}mo`;
  }
  return `${Math.max(0, Math.floor(days))}d`;
}

function formatCompactKarma(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "karma n/a";
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M karma`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}K karma`;
  }
  return `${Math.floor(safe)} karma`;
}

function badgeVoteSortRank(vote: BadgeVoteOption): number {
  const allVotes: BadgeVoteOption[] = [
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
    ...RESULT_PICKER_OPTIONS,
  ];
  const index = allVotes.indexOf(vote);
  return index === -1 ? allVotes.length : index;
}

function createInspectorValueEl(
  vote: BadgeVoteOption | number,
): HTMLDivElement {
  const value = document.createElement("div");
  value.className = "inspector-value";

  if (typeof vote === "number") {
    const numberEl = document.createElement("div");
    numberEl.className = "inspector-vote-number";
    numberEl.textContent = `${vote} Elo`;
    value.appendChild(numberEl);
  } else {
    const icon = document.createElement("div");
    icon.className = "inspector-vote-icon";
    icon.style.backgroundImage = `url(${badgeAsset(vote)})`;
    icon.title = getVoteOptionInfo(vote).label;
    value.appendChild(icon);
  }
  return value;
}

function createInspectorVoteRow(
  userId: string,
  username: string,
  profileUrl: string | null,
  totalKarma: number | null,
  accountAgeDays: number | null,
  vote: BadgeVoteOption | number,
  onRemove: () => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "inspector-vote-row";

  const userBlock = document.createElement("div");
  userBlock.className = "inspector-user";

  const userLink = document.createElement("a");
  userLink.className = "inspector-user-link";

  const userNameEl = document.createElement("div");
  userNameEl.className = "inspector-user-name";
  userNameEl.textContent = `u/${username}`;

  const userMetaEl = document.createElement("div");
  userMetaEl.className = "inspector-user-meta";
  userMetaEl.textContent = `${formatCompactKarma(totalKarma)} • ${formatAccountAgeDays(accountAgeDays)}`;

  const resolvedProfileUrl =
    profileUrl ??
    (!/^t2_/.test(username)
      ? `https://www.reddit.com/user/${encodeURIComponent(username)}/`
      : null);

  userLink.appendChild(userNameEl);
  userLink.href = resolvedProfileUrl ?? "#";
  userLink.target = "_top";
  userLink.rel = "noreferrer noopener";
  userBlock.appendChild(userLink);
  userBlock.appendChild(userMetaEl);
  userLink.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!resolvedProfileUrl) return;
    navigateExternal(resolvedProfileUrl);
  });

  const value = createInspectorValueEl(vote);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "inspector-remove";
  removeBtn.textContent = "X";
  removeBtn.setAttribute("aria-label", `Remove vote from ${username}`);
  removeBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeBtn.disabled = true;
    onRemove();
  });

  row.appendChild(userBlock);
  row.appendChild(value);
  row.appendChild(removeBtn);
  return row;
}

async function removeInspectedVote(target: "elo" | "badge", userId: string, badgeId?: string): Promise<void> {
  const body =
    target === "elo"
      ? { target, userId }
      : { target, userId, badgeId: badgeId ?? "" };
  const res = await fetch(ApiEndpoint.RemoveVote, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to remove vote" }));
    throw new Error((err as { error?: string }).error ?? "Failed to remove vote");
  }
  await refreshPostState(true);
  await ensureInspectData(true);
  if (inspectDetailTarget) {
    renderInspectDetail(inspectDetailTarget, inspectData);
  }
}

function renderInspectDetail(
  target: { kind: "elo" } | { kind: "badge"; badgeId: string },
  data: InspectVotesResponse | null,
): void {
  openInspector();
  inspectorBody.innerHTML = "";
  if (!data) {
    inspectorTitleEl.textContent = "Inspect Votes";
    inspectorMetaEl.textContent = "";
    inspectorBody.innerHTML = '<div class="inspector-loading">Loading vote breakdown...</div>';
    return;
  }

  if (target.kind === "elo") {
    const eloIqm = data.eloVotes.length
      ? interquartileMean(data.eloVotes.map((entry) => entry.elo))
      : null;
    inspectorTitleEl.textContent = "Elo votes";
    inspectorMetaEl.textContent = `IQM ${formatPreciseIqm(eloIqm)} • ${data.eloVotes.length} total`;
    if (!data.eloVotes.length) {
      inspectorBody.innerHTML = '<div class="inspector-empty">No Elo votes yet.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    [...data.eloVotes]
      .sort((a, b) => {
        if (a.elo !== b.elo) return b.elo - a.elo;
        return a.username.localeCompare(b.username);
      })
      .forEach((entry) => {
        fragment.appendChild(
          createInspectorVoteRow(
            entry.userId,
            entry.username,
            entry.profileUrl,
            entry.totalKarma,
            entry.accountAgeDays,
            entry.elo,
            () => {
              void removeInspectedVote("elo", entry.userId).catch((error) => {
                showToast(error instanceof Error ? error.message : "Failed to remove Elo vote");
              });
            },
          ),
        );
      });
    inspectorBody.appendChild(fragment);
    return;
  }

  const placement = getSortedPlacements().find((entry) => entry.id === target.badgeId);
  const votes = data.badgeVotes[target.badgeId] ?? [];
  const winningVote = consensus[target.badgeId]?.winningVote;
  inspectorTitleEl.textContent = winningVote
    ? getVoteOptionInfo(winningVote).label
    : "Badge votes";
  inspectorMetaEl.textContent = `IQM ${formatPreciseIqm(consensus[target.badgeId]?.iqm ?? null)} • ${votes.length} total`;
  if (!placement || !votes.length) {
    inspectorBody.innerHTML = '<div class="inspector-empty">No votes for this badge yet.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  [...votes]
    .sort((a, b) => {
      const rankDelta = badgeVoteSortRank(a.vote) - badgeVoteSortRank(b.vote);
      if (rankDelta !== 0) return rankDelta;
      return a.username.localeCompare(b.username);
    })
    .forEach((entry) => {
      fragment.appendChild(
        createInspectorVoteRow(
          entry.userId,
          entry.username,
          entry.profileUrl,
          entry.totalKarma,
          entry.accountAgeDays,
          entry.vote,
          () => {
            void removeInspectedVote("badge", entry.userId, placement.id).catch((error) => {
              showToast(error instanceof Error ? error.message : "Failed to remove badge vote");
            });
          },
        ),
      );
    });
  inspectorBody.appendChild(fragment);
}

async function openInspectDetail(
  target: { kind: "elo" } | { kind: "badge"; badgeId: string },
  updateHistory = true,
): Promise<void> {
  inspectModeActive = true;
  inspectDetailTarget = target;
  updateInspectChrome();
  renderInspectDetail(target, null);
  if (updateHistory) {
    updateInspectLocation(target);
  }
  let data: InspectVotesResponse;
  try {
    data = await ensureInspectData();
  } catch (error) {
    inspectorBody.innerHTML = `<div class="inspector-empty">${error instanceof Error ? error.message : "Failed to load vote breakdown"}</div>`;
    throw error;
  }
  if (!inspectDetailTarget) return;
  renderInspectDetail(target, data);
}

document.addEventListener(
  "click",
  (event) => {
    if (!swallowSyntheticReleaseClick) return;
    if (Date.now() >= suppressSyntheticReleaseClickUntil) {
      swallowSyntheticReleaseClick = false;
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest(".picker-sheet")) {
      return;
    }
    swallowSyntheticReleaseClick = false;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  },
  true,
);

pickerBg.addEventListener("pointerdown", (event) => {
  if (Date.now() - lastPickerOpenAt < PICKER_CLOSE_GUARD_AFTER_OPEN_MS) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  suppressCanvasExpandUntil = Date.now() + 120;
  closePicker();
});
pickerBg.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  // pointerdown handles close; click is consumed to prevent canvas expand.
});

document.addEventListener("pointerdown", (event) => {
  if (!pickerOvl.classList.contains("open")) return;
  if (Date.now() - lastPickerOpenAt < PICKER_CLOSE_GUARD_AFTER_OPEN_MS) {
    return;
  }
  const target = event.target as HTMLElement;
  if (target.closest(".picker-sheet") || target.closest(".badge")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closePicker();
});

async function voteBadge(p: BadgePlacement, cls: BadgeVoteOption) {
  if (postData && postData.creatorId === viewerUserId) {
    return;
  }

  const previousVote = userVotes[p.id];
  suppressRefreshUntil = Date.now() + REFRESH_AFTER_VOTE_GUARD_MS;
  recentVoteAnimationUntil[p.id] = Date.now() + RECENT_VOTE_ANIMATION_MS;
  suppressPickerReopenUntil = Date.now() + 500;
  suppressCanvasExpandUntil = Date.now() + 320;
  suppressCanvasClickUntil = Date.now() + 320;
  closePicker();
  userVotes[p.id] = cls;
  localVoteGraceUntil[p.id] = Date.now() + 15000;
  layoutBadges();
  persistLocalVoteState();
  scheduleRecentVoteAnimation(p.id);

  try {
    const res = await fetch(ApiEndpoint.VoteBadge, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ badgeId: p.id, classification: cls }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Vote failed" }));
      throw new Error((err as { error?: string }).error ?? "Vote failed");
    }

    const data = (await res.json()) as {
      allConsensus?: Record<string, BadgeConsensus>;
      consensus?: BadgeConsensus;
      counted?: boolean;
      invalidatedBadgeIds?: string[];
    };
    hasEverSubmittedBadgeVote = true;
    closeVoteHint();
    if (data.allConsensus) consensus = data.allConsensus;
    else if (data.consensus) consensus[p.id] = data.consensus;

    for (const invalidId of data.invalidatedBadgeIds ?? []) {
      delete userVotes[invalidId];
      delete localVoteGraceUntil[invalidId];
      delete recentVoteAnimationUntil[invalidId];
    }

    layoutBadges();
    persistLocalVoteState();
  } catch (err) {
    console.error(err);
    if (previousVote) userVotes[p.id] = previousVote;
    else delete userVotes[p.id];
    delete localVoteGraceUntil[p.id];
    layoutBadges();
    persistLocalVoteState();
  }
}

function setupElo() {
  applyEloTrackVisuals();

  if (userElo !== null) {
    eloSlider.value = String(userElo);
  } else {
    eloSlider.value = "1000";
  }

  updateEloDisplay();
  updateGmTickPosition();
  hideEloBubble(true);
}

function updateGmTickPosition() {
  const min = Number(eloSlider.min) || MIN_ELO;
  const max = Number(eloSlider.max) || MAX_ELO;
  const gm = 2500;
  const clamped = Math.max(min, Math.min(max, gm));
  const thumbSize = ELO_THUMB_SIZE_PX;
  const track = eloSlider.clientWidth;
  const t = (clamped - min) / (max - min);
  const x = t * Math.max(0, track - thumbSize) + thumbSize / 2;
  eloGmTick.style.left = `${x}px`;
}

function updateEloDisplay() {
  const val = Number(eloSlider.value);
  eloBubbleText.textContent = `${val} Elo`;
  updateEloBubblePosition();

  if (isOwnPost()) {
    eloBtn.disabled = true;
    eloBtn.textContent = userElo === null ? "Vote" : "Update";
    return;
  }

  if (lastSubmittedElo !== null && val === lastSubmittedElo) {
    eloBtn.disabled = true;
    eloBtn.textContent = `${lastSubmittedElo} Elo`;
    return;
  }

  eloBtn.disabled = false;
  eloBtn.textContent = userElo === null ? "Vote" : "Update";
}

function beginSwipe(
  clientX: number,
  clientY: number,
  nearEdge: boolean,
  badgePlacement: BadgePlacement | null,
  badgeTapNeedsManualOpen: boolean,
): void {
  swipeStartedNearEdge = nearEdge;
  pendingBadgeTapPlacement = badgePlacement;
  pendingBadgeTapNeedsManualOpen = badgeTapNeedsManualOpen;
  swipeTracking = true;
  swipeHorizontal = false;
  swipeLastDx = 0;
  swipeStartX = clientX;
  swipeStartY = clientY;
}

function updateSwipe(clientX: number, clientY: number): boolean {
  if (!swipeTracking || !postData) return false;
  const dx = clientX - swipeStartX;
  const dy = clientY - swipeStartY;
  const androidLike = isAndroidLike();

  if (!swipeHorizontal) {
    const lockDistance = swipeStartedNearEdge
      ? androidLike
        ? 3
        : 4
      : androidLike
      ? 5
      : 6;
    if (Math.abs(dx) < lockDistance && Math.abs(dy) < lockDistance)
      return false;
    if (Math.abs(dx) <= Math.abs(dy) * (androidLike ? 1.08 : 0.95)) {
      swipeTracking = false;
      swipeStartedNearEdge = false;
      pendingBadgeTapPlacement = null;
      pendingBadgeTapNeedsManualOpen = false;
      swipeInputMode = null;
      swipePointerId = null;
      return false;
    }
    swipeHorizontal = true;
    pendingBadgeTapPlacement = null;
    pendingBadgeTapNeedsManualOpen = false;
  }

  const wantsNext = dx < 0;
  const targetIndex = activeImageIndex + (wantsNext ? 1 : -1);
  const canNavigate = targetIndex >= 0 && targetIndex < postData.images.length;
  const adjustedDx = Math.round(canNavigate ? dx : dx * 0.16);
  swipeLastDx = adjustedDx;
  suppressCanvasExpandUntil = Date.now() + 400;
  suppressCanvasClickUntil = Date.now() + 400;
  canvasEl.classList.add("is-dragging");
  canvasImg.style.transition = "none";
  badgesEl.style.transition = "none";
  if (canNavigate) {
    ensureSwipePreview(targetIndex, adjustedDx);
  } else {
    scheduleSwipeTransforms(adjustedDx, null);
    clearSwipePreview();
  }
  return true;
}

function endSwipe(clientX: number, clientY: number): void {
  if (!swipeTracking || !postData) return;
  const wasHorizontal = swipeHorizontal;
  swipeTracking = false;
  swipeHorizontal = false;
  const dx = swipeLastDx || clientX - swipeStartX;
  swipeLastDx = 0;
  swipeInputMode = null;
  swipePointerId = null;
  if (!wasHorizontal) {
    const badgeTapPlacement = pendingBadgeTapPlacement;
    const shouldOpenBadgeTap = pendingBadgeTapNeedsManualOpen;
    swipeStartedNearEdge = false;
    pendingBadgeTapPlacement = null;
    pendingBadgeTapNeedsManualOpen = false;
    clearSwipePreview();
    clearCanvasDragTransform();
    if (
      shouldOpenBadgeTap &&
      badgeTapPlacement &&
      canVoteOnCurrentPost() &&
      !pickerOvl.classList.contains("open") &&
      Date.now() >= suppressPickerReopenUntil
    ) {
      markUserInteraction();
      openPicker(badgeTapPlacement);
    }
    return;
  }
  const nextIndex = activeImageIndex + (dx < 0 ? 1 : -1);
  const canNavigate = nextIndex >= 0 && nextIndex < postData.images.length;
  const commitThreshold = Math.min(
    84,
    Math.max(
      SWIPE_COMMIT_MIN_PX,
      Math.round(
        (canvasEl.clientWidth || canvasEl.getBoundingClientRect().width || 0) *
          SWIPE_COMMIT_RATIO,
      ),
    ),
  );
  if (
    canNavigate &&
    Math.abs(dx) >= commitThreshold &&
    swipePreviewIndex === nextIndex &&
    swipePreviewImg &&
    swipePreviewBadges
  ) {
    finishSwipeNavigation(nextIndex, dx);
    return;
  }
  clearSwipePreview();
  animateCanvasDragReset();
  swipeStartedNearEdge = false;
  pendingBadgeTapPlacement = null;
  pendingBadgeTapNeedsManualOpen = false;
}

function cancelSwipeGesture(): void {
  swipeTracking = false;
  swipeHorizontal = false;
  swipeLastDx = 0;
  swipeStartedNearEdge = false;
  pendingBadgeTapPlacement = null;
  pendingBadgeTapNeedsManualOpen = false;
  swipeInputMode = null;
  swipePointerId = null;
  clearSwipePreview();
  animateCanvasDragReset();
}

function setEloFromClientX(clientX: number): void {
  const rect = eloSlider.getBoundingClientRect();
  if (rect.width <= 0) return;
  const min = Number(eloSlider.min) || MIN_ELO;
  const max = Number(eloSlider.max) || MAX_ELO;
  const step = Number(eloSlider.step) || 50;
  const thumbInset = rect.width > ELO_THUMB_SIZE_PX ? ELO_THUMB_SIZE_PX / 2 : 0;
  const trackLeft = rect.left + thumbInset;
  const trackRight = rect.right - thumbInset;
  const clampedX = Math.max(trackLeft, Math.min(trackRight, clientX));
  const ratio =
    trackRight > trackLeft
      ? (clampedX - trackLeft) / (trackRight - trackLeft)
      : 0;
  const rawValue = min + ratio * (max - min);
  const snappedValue = min + Math.round((rawValue - min) / step) * step;
  const nextValue = Math.max(min, Math.min(max, snappedValue));
  eloSlider.value = String(nextValue);
  updateEloDisplay();
}

function shouldIgnoreAndroidTouchPointer(event: PointerEvent): boolean {
  return isAndroidLike() && event.pointerType === "touch";
}

function endEloPointerInteraction(pointerId?: number): void {
  if (pointerId !== undefined && eloPointerId !== pointerId) return;
  clearEloInteractionFailsafe();
  eloPointerId = null;
  showEloBubble(false);
  hideEloBubble();
}

function endEloTouchInteraction(touchId?: number): void {
  if (touchId !== undefined && eloTouchId !== touchId) return;
  clearEloInteractionFailsafe();
  eloTouchId = null;
  showEloBubble(false);
  hideEloBubble();
}

canvasEl.addEventListener(
  "touchstart",
  (event) => {
    if (swipeInputMode && swipeInputMode !== "touch") return;
    if (!isTouchPrimaryInput() || !postData || postData.images.length <= 1)
      return;
    if (pickerOvl.classList.contains("open")) return;
    const target = event.target as HTMLElement;
    const badgeEl = target.closest(".badge") as HTMLDivElement | null;
    const badgePlacement = findCurrentImagePlacementById(
      badgeEl?.dataset.badgeId,
    );
    if (
      target.closest(".img-nav-btn") ||
      target.closest(".post-menu") ||
      target.closest("#badge-vis-toggle")
    ) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    swipeInputMode = "touch";
    const edgeGuardPx = isAndroidLike() ? 96 : 64;
    const startedOnBadge = !!badgePlacement;
    const nearEdge =
      touch.clientX <= edgeGuardPx ||
      touch.clientX >= window.innerWidth - edgeGuardPx;
    const badgeTapNeedsManualOpen = startedOnBadge && nearEdge;
    beginSwipe(
      touch.clientX,
      touch.clientY,
      nearEdge,
      badgePlacement,
      badgeTapNeedsManualOpen,
    );
    if (
      ((isAndroidLike() || swipeStartedNearEdge) && !startedOnBadge) ||
      badgeTapNeedsManualOpen
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  { passive: false },
);

canvasEl.addEventListener(
  "touchmove",
  (event) => {
    if (swipeInputMode !== "touch") return;
    const touch = event.touches[0];
    if (!touch) return;
    if (!updateSwipe(touch.clientX, touch.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
  },
  { passive: false },
);

canvasEl.addEventListener(
  "touchend",
  (event) => {
    if (swipeInputMode !== "touch") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    endSwipe(touch.clientX, touch.clientY);
  },
  { passive: false },
);

canvasEl.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { passive: false },
);

canvasEl.addEventListener(
  "touchcancel",
  () => {
    if (swipeInputMode !== "touch") return;
    cancelSwipeGesture();
  },
  { passive: true },
);

canvasEl.addEventListener("pointerdown", (event) => {
  if (swipeInputMode && swipeInputMode !== "pointer") return;
  if (!isTouchPrimaryInput() || !postData || postData.images.length <= 1)
    return;
  if (pickerOvl.classList.contains("open")) return;
  if (event.button !== 0) return;
  const target = event.target as HTMLElement;
  const badgeEl = target.closest(".badge") as HTMLDivElement | null;
  const badgePlacement = findCurrentImagePlacementById(
    badgeEl?.dataset.badgeId,
  );
  if (
    target.closest(".img-nav-btn") ||
    target.closest(".post-menu") ||
    target.closest("#badge-vis-toggle")
  ) {
    return;
  }
  swipeInputMode = "pointer";
  swipePointerId = event.pointerId;
  const edgeGuardPx = isAndroidLike() ? 96 : 64;
  const startedOnBadge = !!badgePlacement;
  const nearEdge =
    event.clientX <= edgeGuardPx ||
    event.clientX >= window.innerWidth - edgeGuardPx;
  const badgeTapNeedsManualOpen = startedOnBadge && nearEdge;
  beginSwipe(
    event.clientX,
    event.clientY,
    nearEdge,
    badgePlacement,
    badgeTapNeedsManualOpen,
  );
  try {
    canvasEl.setPointerCapture(event.pointerId);
  } catch {}
  if (
    ((isAndroidLike() || swipeStartedNearEdge) && !startedOnBadge) ||
    badgeTapNeedsManualOpen
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
});

canvasEl.addEventListener("pointermove", (event) => {
  if (swipeInputMode !== "pointer" || swipePointerId !== event.pointerId)
    return;
  if (!updateSwipe(event.clientX, event.clientY)) return;
  event.preventDefault();
  event.stopPropagation();
});

canvasEl.addEventListener("pointerup", (event) => {
  if (swipeInputMode !== "pointer" || swipePointerId !== event.pointerId)
    return;
  endSwipe(event.clientX, event.clientY);
  try {
    canvasEl.releasePointerCapture(event.pointerId);
  } catch {}
});

canvasEl.addEventListener("pointercancel", (event) => {
  if (swipeInputMode !== "pointer" || swipePointerId !== event.pointerId)
    return;
  cancelSwipeGesture();
  try {
    canvasEl.releasePointerCapture(event.pointerId);
  } catch {}
});

document.addEventListener(
  "touchstart",
  (event) => {
    if (!isTouchPrimaryInput() || !postData || postData.images.length <= 1) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const rect = canvasEl.getBoundingClientRect();
    if (
      touch.clientX < rect.left ||
      touch.clientX > rect.right ||
      touch.clientY < rect.top ||
      touch.clientY > rect.bottom
    ) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(".img-nav-btn") ||
      target.closest(".post-menu") ||
      target.closest("#badge-vis-toggle") ||
      pickerOvl.classList.contains("open")
    ) {
      return;
    }
    if (touch.clientX <= 64 || touch.clientX >= window.innerWidth - 64) {
      event.preventDefault();
    }
  },
  { passive: false, capture: true },
);

document.addEventListener(
  "touchmove",
  (event) => {
    if (!swipeTracking || (!swipeHorizontal && !swipeStartedNearEdge)) return;
    event.preventDefault();
  },
  { passive: false, capture: true },
);

document.addEventListener(
  "touchend",
  () => {
    swipeStartedNearEdge = false;
  },
  { passive: true, capture: true },
);

eloSlider.addEventListener("pointerdown", (event) => {
  if (shouldIgnoreAndroidTouchPointer(event)) return;
  if (event.button !== 0) return;
  eloPointerId = event.pointerId;
  clearEloInteractionFailsafe();
  setEloFromClientX(event.clientX);
  showEloBubble(true);
});

eloSlider.addEventListener("pointermove", (event) => {
  if (shouldIgnoreAndroidTouchPointer(event)) return;
  if (eloPointerId !== event.pointerId) return;
  clearEloInteractionFailsafe();
  showEloBubble(true);
});

eloSlider.addEventListener("pointerup", (event) => {
  if (shouldIgnoreAndroidTouchPointer(event)) return;
  endEloPointerInteraction(event.pointerId);
});

eloSlider.addEventListener("pointercancel", (event) => {
  if (shouldIgnoreAndroidTouchPointer(event)) return;
  endEloPointerInteraction(event.pointerId);
});

document.addEventListener(
  "pointerup",
  (event) => {
    endEloPointerInteraction(event.pointerId);
    hideEloBubbleIfIdle();
  },
  { capture: true },
);

document.addEventListener(
  "pointercancel",
  (event) => {
    endEloPointerInteraction(event.pointerId);
    hideEloBubbleIfIdle();
  },
  { capture: true },
);

eloSlider.addEventListener(
  "touchstart",
  (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    eloTouchId = touch.identifier;
    clearEloInteractionFailsafe();
    setEloFromClientX(touch.clientX);
    showEloBubble(true);
  },
  { passive: false },
);

eloSlider.addEventListener(
  "touchmove",
  (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (eloTouchId !== null && touch.identifier !== eloTouchId) return;
    clearEloInteractionFailsafe();
    showEloBubble(true);
  },
  { passive: false },
);

eloSlider.addEventListener(
  "touchend",
  (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    endEloTouchInteraction(touch.identifier);
  },
  { passive: false },
);

eloSlider.addEventListener(
  "touchcancel",
  (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    endEloTouchInteraction(touch.identifier);
  },
  { passive: false },
);

eloSlider.addEventListener("input", () => {
  updateEloDisplay();
  showEloBubble(isEloInteractionActive());
});
eloSlider.addEventListener("focus", () => {
  updateEloDisplay();
  if (Date.now() >= suppressEloBubbleUntil) {
    showEloBubble(false);
  }
});
eloSlider.addEventListener("blur", () => {
  clearEloInteractionFailsafe();
  hideEloBubble();
});
eloSlider.addEventListener("change", () => {
  hideEloBubbleIfIdle();
});
window.addEventListener("resize", () => {
  updateEloBubblePosition();
  schedulePostLayoutRefresh();
});

eloBtn.addEventListener("click", async () => {
  suppressEloBubbleUntil = Date.now() + 350;
  endEloTouchInteraction();
  endEloPointerInteraction();
  eloSlider.blur();
  hideEloBubble(true);
  if (postData && postData.creatorId === viewerUserId) {
    showToast("You can’t vote on your own post");
    return;
  }

  const elo = Number(eloSlider.value);
  const hadPrevious = userElo !== null;
  eloBtn.disabled = true;
  try {
    const res = await fetch(ApiEndpoint.VoteElo, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elo }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "ELO vote failed" }));
      throw new Error((err as { error?: string }).error ?? "ELO vote failed");
    }

    (await res.json()) as {
      consensusElo: number;
      voteCount: number;
      targetLabel: string;
      counted?: boolean;
    };

    userElo = elo;
    lastSubmittedElo = elo;
    showToast(hadPrevious ? "Vote updated successfully" : "Voted successfully");
    updateEloDisplay();
  } catch (err) {
    console.error(err);
  } finally {
    updateEloDisplay();
  }
});

init();
