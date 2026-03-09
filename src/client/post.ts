import { requestExpandedMode, showToast } from "@devvit/client";
import {
  ApiEndpoint,
  BADGE_INFO,
  BADGE_HINTS,
  Classification,
  PICKER_CLASSIFICATIONS,
  getEloColor,
  MIN_VOTES_FOR_BADGE_CONSENSUS,
  MAX_POST_AGE_TO_VOTE_MS,
  MIN_ELO,
  MAX_ELO,
  type InitResponse,
  type BadgeConsensus,
  type BadgePlacement,
  type PostData,
} from "../shared/api.ts";

let postData: PostData | null = null;
let consensus: Record<string, BadgeConsensus> = {};
let userVotes: Record<string, Classification> = {};
const localVoteGraceUntil: Record<string, number> = {};
let userElo: number | null = null;
let lastSubmittedElo: number | null = null;
let activeImageIndex = 0;
let currentPostId = "";
let viewerOwnsPost = false;
let viewerUserId = "";
let viewerIsLoggedIn = false;
let viewerIsModerator = false;
let refreshTimer: number | null = null;
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
const PAGE_SLIDE_DURATION_MS = 150;
const ELO_THUMB_SIZE_PX = 24;
const UNVOTED_RING_WIDTH_PX = 1.5;
const BADGE_VISIBILITY_TOGGLE_ENABLED = false;
const PICKER_ITEM_CLICK_FALLBACK_GUARD_MS = 500;
const PICKER_CLOSE_GUARD_AFTER_OPEN_MS = 180;
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
const quickCreateBtn = $("quick-create") as HTMLButtonElement;
const modEditBtn = $("mod-edit") as HTMLButtonElement;
const badgeVisToggleBtn = $("badge-vis-toggle") as HTMLButtonElement;
const eloEl = $("elo") as HTMLDivElement;
const eloLoginEl = document.getElementById(
  "elo-login",
) as HTMLDivElement | null;
const eloLoginTextEl = document.getElementById(
  "elo-login-text",
) as HTMLDivElement | null;
const eloSlider = $("elo-slider") as HTMLInputElement;
const eloVal = $("elo-val") as HTMLSpanElement;
const eloBtn = $("elo-btn") as HTMLButtonElement;
const eloGmTick = $("elo-gm-tick") as HTMLDivElement;
const createPrompt = $("create-prompt") as HTMLDivElement;
const createBtn = $("create-btn") as HTMLButtonElement;

const pickerOvl = $("picker-overlay") as HTMLDivElement;
const pickerBg = $("picker-bg") as HTMLDivElement;
const pickerTitle = $("picker-title") as HTMLDivElement;
const pickerBody = $("picker-body") as HTMLDivElement;
const query = new URLSearchParams(window.location.search);
const isExpandedView =
  query.get("expanded") === "1" ||
  window.location.pathname.endsWith("/post-expanded.html");

if (isAndroidLike()) {
  canvasEl.style.touchAction = "none";
  badgesEl.style.touchAction = "none";
  imageNav.style.touchAction = "none";
}

function pageStateStorageKey(): string | null {
  return currentPostId ? `tt:page:${currentPostId}` : null;
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
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.transition = "";
  badgesEl.style.transition = "";
  canvasImg.style.transform = "";
  badgesEl.style.transform = "";
}

function clearSwipePreview(): void {
  swipePreviewImg?.remove();
  swipePreviewBadges?.remove();
  swipePreviewImg = null;
  swipePreviewBadges = null;
  swipePreviewIndex = null;
}

function preloadImage(imageUrl: string): void {
  if (!imageUrl || imagePreloadCache.has(imageUrl)) return;
  const img = new Image();
  img.decoding = "async";
  img.src = imageUrl;
  imagePreloadCache.set(imageUrl, img);
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
  canvasImg.style.transform = "translateX(0)";
  badgesEl.style.transform = "translateX(0)";
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
  canvasImg.style.transform = "translateX(0)";
  badgesEl.style.transform = "translateX(0)";
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
  swipePreviewImg.style.transition = "none";
  swipePreviewBadges.style.transition = "none";
  swipePreviewImg.style.transform = "translateX(0)";
  swipePreviewBadges.style.transform = "translateX(0)";
  commitSwipeNavigation(nextIndex);
}

function animateCanvasDragReset(): void {
  canvasEl.classList.remove("is-dragging");
  canvasImg.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
  badgesEl.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
  canvasImg.style.transform = "translateX(0)";
  badgesEl.style.transform = "translateX(0)";
  window.setTimeout(() => {
    canvasImg.style.transition = "";
    badgesEl.style.transition = "";
    canvasImg.style.transform = "";
    badgesEl.style.transform = "";
  }, 220);
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
    swipePreviewImg.style.transform = `translateX(${previewX}px)`;
  }
  if (swipePreviewBadges) {
    swipePreviewBadges.style.transition = "none";
    swipePreviewBadges.style.transform = `translateX(${previewX}px)`;
  }
  return true;
}

function syncActiveImageIndexFromStorage(): void {
  if (!postData || navTransitionInFlight || isExpandedView) return;
  const nextIndex = readStoredImageIndex(postData.images.length);
  if (nextIndex === null || nextIndex === activeImageIndex) return;
  applyImageIndexImmediately(nextIndex);
}

function resetPostTransientOverlays(): void {
  pickerOvl.classList.remove("open");
}

resetPostTransientOverlays();
window.addEventListener("pageshow", () => {
  resetPostTransientOverlays();
  syncActiveImageIndexFromStorage();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isExpandedView) {
    writeActiveImageIndexToStorage();
  }
  if (document.visibilityState === "visible") {
    resetPostTransientOverlays();
    syncActiveImageIndexFromStorage();
  }
});
window.addEventListener("focus", () => {
  resetPostTransientOverlays();
  syncActiveImageIndexFromStorage();
});
window.addEventListener("pagehide", () => {
  if (isExpandedView) {
    writeActiveImageIndexToStorage();
  }
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

function schedulePostLayoutRefresh(): void {
  if (postLayoutRaf !== null) return;
  postLayoutRaf = window.requestAnimationFrame(() => {
    postLayoutRaf = null;
    layoutBadges(true);
    applyEloTrackVisuals();
    updateGmTickPosition();
  });
}

function badgeAsset(cls: Classification): string {
  return `/assets/badges/${cls.toLowerCase()}.png`;
}

function unknownBadgeAsset(): string {
  return "/assets/badges/unknown.png";
}

function ringPhaseDelaySeconds(): number {
  const nowMs =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  return -((nowMs % 15000) / 1000);
}

const stableRingPhaseDelaySeconds = ringPhaseDelaySeconds();

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
      const consensusCls = c?.classification ?? "";
      const consensusTotal = c?.totalVotes ?? 0;
      return [
        placement.id,
        placement.x,
        placement.y,
        placement.radius,
        placement.classification ?? "",
        vote,
        consensusCls,
        consensusTotal,
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

function updateVoteFooter(initializeElo = false): void {
  if (
    !postData ||
    postData.mode !== "vote" ||
    isExpandedView ||
    !isVotingWindowOpen()
  ) {
    eloEl.style.display = "none";
    if (eloLoginEl) eloLoginEl.style.display = "none";
    return;
  }

  if (isOwnPost()) {
    eloEl.style.display = "none";
    if (eloLoginTextEl) {
      eloLoginTextEl.textContent = "Your post is being voted on";
    }
    if (eloLoginEl) eloLoginEl.style.display = "flex";
    return;
  }

  if (!viewerIsLoggedIn) {
    eloEl.style.display = "none";
    if (eloLoginTextEl) {
      eloLoginTextEl.textContent = "Log in to vote";
    }
    if (eloLoginEl) eloLoginEl.style.display = "flex";
    return;
  }

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
    userElo = data.userElo;
    lastSubmittedElo = userElo;
    viewerUserId = data.userId;
    viewerIsLoggedIn = !!data.userId;
    viewerIsModerator = !!data.isModerator;

    loadingEl.style.display = "none";

    if (!postData) {
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

    postEl.style.display = "flex";
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
    quickCreateBtn.addEventListener("click", (event) => {
      try {
        requestExpandedMode(event as unknown as MouseEvent, "create");
      } catch {
        window.location.href = "/app.html";
      }
    });
    if (isExpandedView) {
      quickCreateBtn.style.display = "none";
      badgeVisToggleBtn.style.display = "none";
      modEditBtn.style.display = "none";
    }

    if (viewerIsModerator && !isExpandedView) {
      modEditBtn.style.display = "inline-flex";
      modEditBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          requestExpandedMode(event as unknown as MouseEvent, "edit");
        } catch {
          window.location.href = "/app.html?mode=edit";
        }
      });
    } else {
      modEditBtn.style.display = "none";
    }

    if (postData.images.length > 1) imageNav.style.display = "flex";
    updateImageNav();
    preloadNearbyImages();
    loadCurrentImage(false);
    updateVoteFooter(true);

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
      });
    }
  } catch (err) {
    console.error("Init failed:", err);
    loadingEl.style.display = "none";
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

async function refreshPostState() {
  if (!postData || document.hidden) return;
  if (pickerOvl.classList.contains("open")) return;
  if (Date.now() - lastUserInteractionAt < 900) return;
  try {
    const currentImageUrl = currentImage()?.imageUrl ?? null;
    const res = await fetch(ApiEndpoint.Init);
    if (!res.ok) return;
    const data = (await res.json()) as InitResponse;
    if (!data.postData) return;

    postData = normalizePostData(data.postData);
    currentPostId = data.postId;
    viewerOwnsPost = !!data.isOwnPost;
    consensus = data.consensus;
    const now = Date.now();
    const nextVotes: Record<string, Classification> = { ...data.userVotes };
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
    requestAnimationFrame(() => {
      if (token !== imageLoadToken) return;
      layoutBadges(true);
      if (shouldAnimate && directionForAnimation) {
        playSlideAnimation(directionForAnimation, snapshotForAnimation);
      } else {
        completeNavigationTransition();
      }
    });
    imageSlideDirection = null;
  };

  const imageUrl = image.imageUrl;
  const currentUrl = canvasImg.currentSrc || canvasImg.src;
  if (currentUrl && currentUrl === imageUrl) {
    finalizeLoadedImage();
    return;
  }

  const preloader = new Image();
  preloader.decoding = "async";
  preloader.onload = finalizeLoadedImage;
  preloader.onerror = finalizeLoadedImage;
  preloader.src = imageUrl;
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
    !!postData && postData.mode === "vote" && !isVotingWindowOpen();
  if (
    (target.closest(".badge") && !badgeClicksOpenExpanded) ||
    target.closest(".img-nav-btn") ||
    target.closest("#quick-create") ||
    target.closest("#mod-edit") ||
    target.closest("#badge-vis-toggle") ||
    target.closest(".image-nav")
  ) {
    return;
  }
  const expandedUrl = `/post.html?expanded=1&page=${activeImageIndex + 1}`;
  writeActiveImageIndexToStorage();
  try {
    requestExpandedMode(event as unknown as MouseEvent, "expanded");
  } catch {
    window.location.href = expandedUrl;
  }
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
    const hasConsensus =
      !!c?.classification && c.totalVotes >= MIN_VOTES_FOR_BADGE_CONSENSUS;
    const isLiveVoteWindow = pd.mode === "vote" && isVotingWindowOpen();
    let badgeImageUrl: string | null = null;

    if (pd.mode === "annotated" && p.classification) {
      el.classList.add("badge--voted");
      badgeImageUrl = badgeAsset(p.classification);
    } else {
      if (hasConsensus) {
        el.classList.add("badge--voted");
        badgeImageUrl = badgeAsset(c!.classification!);
      } else {
        el.classList.add("badge--placeholder");
        badgeImageUrl = unknownBadgeAsset();
      }

      if (badgeImageUrl) {
        const faceEl = document.createElement("div");
        faceEl.className = "badge-face";
        if (isLiveVoteWindow) {
          faceEl.classList.add("badge-face--unlocked");
        }
        faceEl.style.backgroundImage = `url(${badgeImageUrl})`;
        el.appendChild(faceEl);
      }

      if (pd.mode === "vote") {
        if (!uv && canVoteOnCurrentPost()) {
          el.classList.add("badge--ring");
          el.classList.add("badge--tappable");
          el.style.setProperty(
            "--ring-delay",
            `${stableRingPhaseDelaySeconds}s`,
          );
          el.style.setProperty("--ring-width", `${UNVOTED_RING_WIDTH_PX}px`);
        }

        if (uv && !isOwnPost() && canVoteOnCurrentPost()) {
          const voteEl = document.createElement("div");
          voteEl.className = "badge-vote";
          const voteSz = Math.max(12, sizePx * 0.42);
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

    if (interactive && pd.mode === "vote" && canVoteOnCurrentPost()) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() < suppressPickerReopenUntil) {
          return;
        }
        markUserInteraction();
        openPicker(p);
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
  const sorted = (postData?.images ?? [])
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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

  pickerTitle.textContent = "Vote for Classification (Best → Worst)";
  pickerBody.innerHTML = "";
  activeHintEl = null;

  const grid = document.createElement("div");
  grid.className = "pk-grid";

  const bookValid = isBookValidForVote(p);

  for (const cls of PICKER_CLASSIFICATIONS) {
    const item = createPickerItem(
      cls,
      currentVote,
      p,
      cls === Classification.BOOK && !bookValid,
    );
    grid.appendChild(item);
  }

  pickerBody.appendChild(grid);
  pickerOvl.classList.add("open");
}

function createPickerItem(
  cls: Classification,
  currentVote: Classification | undefined,
  p: BadgePlacement,
  disabled: boolean,
) {
  const info = BADGE_INFO[cls];
  const hint = BADGE_HINTS[cls];
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

async function voteBadge(p: BadgePlacement, cls: Classification) {
  if (postData && postData.creatorId === viewerUserId) {
    return;
  }

  const previousVote = userVotes[p.id];
  suppressPickerReopenUntil = Date.now() + 500;
  suppressCanvasExpandUntil = Date.now() + 320;
  suppressCanvasClickUntil = Date.now() + 320;
  closePicker();
  userVotes[p.id] = cls;
  localVoteGraceUntil[p.id] = Date.now() + 15000;
  layoutBadges();

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
    if (data.allConsensus) consensus = data.allConsensus;
    else if (data.consensus) consensus[p.id] = data.consensus;

    for (const invalidId of data.invalidatedBadgeIds ?? []) {
      delete userVotes[invalidId];
      delete localVoteGraceUntil[invalidId];
    }

    if (userVotes[p.id] === cls) {
      delete localVoteGraceUntil[p.id];
    }

    layoutBadges();
  } catch (err) {
    console.error(err);
    if (previousVote) userVotes[p.id] = previousVote;
    else delete userVotes[p.id];
    delete localVoteGraceUntil[p.id];
    layoutBadges();
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
  eloVal.textContent = `${val} Elo`;

  if (isOwnPost()) {
    eloBtn.disabled = true;
    eloBtn.textContent = userElo === null ? "Vote" : "Update";
    return;
  }

  if (lastSubmittedElo !== null && val === lastSubmittedElo) {
    eloBtn.disabled = true;
    eloBtn.textContent = "Voted";
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
  const adjustedDx = canNavigate ? dx : dx * 0.2;
  swipeLastDx = adjustedDx;
  suppressCanvasExpandUntil = Date.now() + 400;
  suppressCanvasClickUntil = Date.now() + 400;
  canvasEl.classList.add("is-dragging");
  canvasImg.style.transition = "none";
  badgesEl.style.transition = "none";
  canvasImg.style.transform = `translateX(${adjustedDx}px)`;
  badgesEl.style.transform = `translateX(${adjustedDx}px)`;
  if (canNavigate) {
    ensureSwipePreview(targetIndex, adjustedDx);
  } else {
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
  if (
    canNavigate &&
    Math.abs(dx) >= 56 &&
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
  const min = Number(eloSlider.min) || MIN_ELO;
  const max = Number(eloSlider.max) || MAX_ELO;
  const step = Number(eloSlider.step) || 50;
  const thumbInset = rect.width > ELO_THUMB_SIZE_PX ? ELO_THUMB_SIZE_PX / 2 : 0;
  const trackLeft = rect.left + thumbInset;
  const trackRight = rect.right - thumbInset;
  const clampedX = Math.max(trackLeft, Math.min(trackRight, clientX));
  const t =
    trackRight > trackLeft
      ? (clampedX - trackLeft) / (trackRight - trackLeft)
      : 0;
  const raw = min + t * (max - min);
  const snapped = min + Math.round((raw - min) / step) * step;
  const value = Math.max(min, Math.min(max, snapped));
  eloSlider.value = String(value);
  updateEloDisplay();
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
      target.closest("#quick-create") ||
      target.closest("#mod-edit") ||
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
    target.closest("#quick-create") ||
    target.closest("#mod-edit") ||
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
      target.closest("#quick-create") ||
      target.closest("#mod-edit") ||
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
  if (!isTouchPrimaryInput() || event.button !== 0) return;
  eloPointerId = event.pointerId;
  try {
    eloSlider.setPointerCapture(event.pointerId);
  } catch {}
  setEloFromClientX(event.clientX);
  event.preventDefault();
});

eloSlider.addEventListener("pointermove", (event) => {
  if (eloPointerId !== event.pointerId) return;
  setEloFromClientX(event.clientX);
  event.preventDefault();
});

function clearEloPointer(pointerId: number): void {
  if (eloPointerId !== pointerId) return;
  eloPointerId = null;
  try {
    eloSlider.releasePointerCapture(pointerId);
  } catch {}
}

eloSlider.addEventListener("pointerup", (event) => {
  if (eloPointerId !== event.pointerId) return;
  setEloFromClientX(event.clientX);
  clearEloPointer(event.pointerId);
});

eloSlider.addEventListener("pointercancel", (event) => {
  clearEloPointer(event.pointerId);
});

eloSlider.addEventListener("input", updateEloDisplay);
window.addEventListener("resize", () => {
  schedulePostLayoutRefresh();
});

eloBtn.addEventListener("click", async () => {
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
