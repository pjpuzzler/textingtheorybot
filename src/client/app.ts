import { navigateTo } from "@devvit/client";
import {
  ApiEndpoint,
  Classification,
  PICKER_CLASSIFICATIONS,
  BADGE_INFO,
  BADGE_HINTS,
  MAX_VOTE_POST_IMAGES,
  MAX_ANNOTATED_POST_IMAGES,
  type InitResponse,
  type CreatePostRequest,
  type CreatePostResponse,
  type UpdatePostRequest,
  type UpdatePostResponse,
  type BadgePlacement,
  type PostMode,
  type EloSide,
} from "../shared/api.ts";

type RedactionPoint = {
  x: number;
  y: number;
};

type RedactionStroke = {
  points: RedactionPoint[];
  widthPct: number;
};

type EditorImage = {
  dataUrl: string;
  base64: string;
  mime: string;
  width: number;
  height: number;
  placements: BadgePlacement[];
  redactions: RedactionStroke[];
};

const MAX_IMAGE_DIM = 2048;
const VOTE_MIN_RADIUS = 3;
const VOTE_MAX_RADIUS = 7;
const ANNOTATED_MIN_RADIUS = 3;
const ANNOTATED_MAX_RADIUS = 7;
const ANNOTATED_EXPORT_MIN_LONG_SIDE = 1280;
const REDACTION_STROKE_WIDTH_PCT = 1.25;
const PAGE_SLIDE_DURATION_MS = 150;

let mode: PostMode = "vote";
let selectedId: string | null = null;
let globalRadius = 6;
let eloSide: EloSide = "right";
let meChecked = true;
let pointerState: {
  badgeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
} | null = null;

let images: EditorImage[] = [];
let activeImageIndex = 0;
let isSubmitting = false;
let markerModeEnabled = false;
let drawingPointerId: number | null = null;
let activeStroke: RedactionStroke | null = null;
let imageSlideDirection: "prev" | "next" | null = null;
let pendingCreateSlideImageSrc: string | null = null;
let pendingCreateSlideBadges: {
  badgesHtml: string;
  badgesLeft: string;
  badgesTop: string;
  badgesWidth: string;
  badgesHeight: string;
} | null = null;
let navTransitionInFlight = false;
let queuedNavIndex: number | null = null;
let isEditSession = false;
let editorLayoutRaf: number | null = null;

function scheduleEditorLayoutRefresh(): void {
  if (editorLayoutRaf !== null) return;
  editorLayoutRaf = window.requestAnimationFrame(() => {
    editorLayoutRaf = null;
    if (!images.length) return;
    render();
  });
}

const $ = (id: string) => document.getElementById(id)!;

const screenMode = $("screen-mode") as HTMLDivElement;
const btnVote = $("btn-vote");
const btnAnn = $("btn-annotate");
const fileInput = $("file-input") as HTMLInputElement;

const createModal = $("create-modal") as HTMLDivElement;
const cmTitle = $("cm-title") as HTMLInputElement;
const cmImg = $("cm-img") as HTMLImageElement;
const cmRedactLayer = $("cm-redact-layer") as HTMLCanvasElement;
const cmCanvasWrap = $("cm-canvas-wrap") as HTMLDivElement;
const cmBadges = $("cm-badges") as HTMLDivElement;
const cmMarkerToggle = $("cm-marker-toggle") as HTMLButtonElement;
const hintEl = $("hint") as HTMLDivElement;
const cmPageChip = $("cm-page-chip") as HTMLDivElement;
const cmImageNav = $("cm-image-nav") as HTMLDivElement;
const cmImgPrev = $("cm-img-prev") as HTMLButtonElement;
const cmImgNext = $("cm-img-next") as HTMLButtonElement;
const cmImgDots = $("cm-img-dots") as HTMLDivElement;

const cmSize = $("cm-size") as HTMLInputElement;
const cmOrderUp = $("cm-order-up") as HTMLButtonElement;
const cmOrderDown = $("cm-order-down") as HTMLButtonElement;
const cmPost = $("cm-btn-post") as HTMLButtonElement;
const cmNext = $("cm-btn-next") as HTMLButtonElement;
const submitOvl = $("overlay-submit") as HTMLDivElement;
const submitText = $("overlay-submit-text") as HTMLParagraphElement;
const detailsModal = $("details-modal") as HTMLDivElement;
const detailsBg = $("details-bg") as HTMLDivElement;
const singleBadgeModal = $("single-badge-modal") as HTMLDivElement;
const singleBadgeBg = $("single-badge-bg") as HTMLDivElement;
const singleBadgeCancel = $("single-badge-cancel") as HTMLButtonElement;
const singleBadgeContinue = $("single-badge-continue") as HTMLButtonElement;

const sideLeftBtn = $("side-left") as HTMLButtonElement;
const sideRightBtn = $("side-right") as HTMLButtonElement;
const sideOtherBtn = $("side-other") as HTMLButtonElement;
const meCheck = $("me-check") as HTMLInputElement;
const meCheckLabel = $("me-check-label") as HTMLLabelElement;
const sideRow = $("side-row") as HTMLDivElement;
const voteTargetControls = $("vote-target-controls") as HTMLDivElement;
const otherRow = $("other-row") as HTMLDivElement;
const otherInput = $("cm-other") as HTMLInputElement;

const pickerModal = $("picker-modal") as HTMLDivElement;
const pickerBg = $("picker-bg") as HTMLDivElement;
const pickerTitle = $("picker-title") as HTMLDivElement;
const pickerBody = $("picker-body") as HTMLDivElement;

let pendingNewAnnotation: BadgePlacement | null = null;
let suppressEditorPickerUntil = 0;

const OTHER_ELO_LABEL_REGEX = /^[A-Za-z]{1,16}$/;
const TITLE_FORBIDDEN_CHARS_REGEX = /[\[\]]/g;
const query = new URLSearchParams(window.location.search);
const isEditBootRequested =
  query.get("mode") === "edit" ||
  window.location.pathname.endsWith("/app-edit.html");

if (isEditBootRequested) {
  screenMode.style.display = "none";
  createModal.classList.add("open");
  submitOvl.style.display = "flex";
  submitText.textContent = "Loading editor…";
}

function sanitizeOtherEloLabel(value: string): string {
  return value.replace(/[^A-Za-z]/g, "").slice(0, 16);
}

async function loadRemoteImageAsEditorImage(
  imageUrl: string,
  placements: BadgePlacement[],
): Promise<EditorImage> {
  const response = await fetch(imageUrl, { mode: "cors" });
  if (!response.ok) {
    throw new Error("Failed to fetch existing post image");
  }
  const blob = await response.blob();
  const dataUrl = await readBlobAsDataUrl(blob);
  const loaded = await loadImage(dataUrl);
  return {
    dataUrl,
    base64: dataUrl.split(",")[1] ?? "",
    mime: blob.type || "image/png",
    width: loaded.naturalWidth || loaded.width,
    height: loaded.naturalHeight || loaded.height,
    placements: placements.map((placement) => ({ ...placement })),
    redactions: [],
  };
}

async function initEditSessionIfRequested(): Promise<void> {
  if (!isEditBootRequested) return;

  try {
    const res = await fetch(ApiEndpoint.Init);
    if (!res.ok) throw new Error("Failed to load post");
    const data = (await res.json()) as InitResponse;
    if (!data.isModerator) {
      throw new Error("Only moderators can edit posts");
    }
    if (!data.postData) {
      throw new Error("No post data found for this post");
    }

    isEditSession = true;
    mode = data.postData.mode;
    eloSide = data.postData.eloSide ?? "right";
    meChecked =
      data.postData.eloSide === "me" || data.postData.eloSide === "right";

    images = await Promise.all(
      data.postData.images.map((image) =>
        loadRemoteImageAsEditorImage(image.imageUrl, image.placements),
      ),
    );
    normalizePlacementOrders();
    activeImageIndex = 0;
    cmNext.textContent = "Save";
    cmPost.textContent = "Save";
    detailsModal.classList.remove("open");
    openEditor();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start edit mode";
    alert(message);
    window.location.href = "/";
  } finally {
    submitOvl.style.display = "none";
  }
}

globalRadius = Number(cmSize.value) || globalRadius;

function maxImagesForMode(): number {
  return mode === "annotated"
    ? MAX_ANNOTATED_POST_IMAGES
    : MAX_VOTE_POST_IMAGES;
}

function sliderMinForMode(): number {
  return mode === "annotated" ? ANNOTATED_MIN_RADIUS : VOTE_MIN_RADIUS;
}

function sliderMaxForMode(): number {
  return mode === "annotated" ? ANNOTATED_MAX_RADIUS : VOTE_MAX_RADIUS;
}

function applySliderBoundsForMode(): void {
  const min = sliderMinForMode();
  const max = sliderMaxForMode();
  cmSize.min = String(min);
  cmSize.max = String(max);
  const current = Number(cmSize.value) || globalRadius;
  if (current < min) {
    cmSize.value = String(min);
  } else if (current > max) {
    cmSize.value = String(max);
  }
  globalRadius = Number(cmSize.value) || Math.min(max, Math.max(min, 6));
}

function editorBoxSize(): { width: number; height: number } {
  return {
    width: Math.max(1, cmCanvasWrap.clientWidth || 1),
    height: Math.max(1, cmCanvasWrap.clientHeight || 1),
  };
}

function editorUniformScaleBase(): number {
  const box = editorBoxSize();
  return Math.min(box.width, box.height);
}

function imageScaleBaseForIndex(index: number): number {
  const image = images[index];
  if (!image) return 1;
  const box = editorBoxSize();
  const iw = Math.max(1, image.width || 1);
  const ih = Math.max(1, image.height || 1);
  const containScale = Math.min(box.width / iw, box.height / ih);
  const renderedW = iw * containScale;
  const renderedH = ih * containScale;
  return Math.max(1, Math.max(renderedW, renderedH));
}

function mapUniformRadiusToImageRadius(
  baseRadius: number,
  index: number,
): number {
  const uniformBase = editorUniformScaleBase();
  const imageBase = imageScaleBaseForIndex(index);
  const diameterPx = ((baseRadius * 2) / 100) * uniformBase;
  return (diameterPx / imageBase) * 50;
}

function markerScaleBase(rect: ReturnType<typeof canvasRect>): number {
  return Math.max(rect.imgW, rect.imgH);
}

function syncPlacementRadiiFromSlider(): void {
  for (const [index, image] of images.entries()) {
    const mappedRadius = mapUniformRadiusToImageRadius(globalRadius, index);
    for (const placement of image.placements) {
      placement.radius = mappedRadius;
    }
  }
}

btnVote.addEventListener("click", () => {
  mode = "vote";
  applySliderBoundsForMode();
  fileInput.multiple = true;
  fileInput.click();
});

btnAnn.addEventListener("click", () => {
  mode = "annotated";
  applySliderBoundsForMode();
  fileInput.multiple = false;
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  if (!files.length) return;

  const room = maxImagesForMode();
  const selected = files.slice(0, Math.max(0, room));
  if (!selected.length) {
    fileInput.value = "";
    return;
  }

  const built: EditorImage[] = [];
  for (const file of selected) {
    const downscaled = await toDownscaledData(file);
    built.push({
      dataUrl: downscaled.dataUrl,
      base64: downscaled.base64,
      mime: downscaled.mime,
      width: downscaled.width,
      height: downscaled.height,
      placements: [],
      redactions: [],
    });
  }

  images = built;
  activeImageIndex = 0;
  openEditor();

  fileInput.value = "";
});

function getActiveImage(): EditorImage {
  return images[activeImageIndex]!;
}

function getActivePlacements(): BadgePlacement[] {
  return getActiveImage().placements;
}

function getActiveRedactions(): RedactionStroke[] {
  return getActiveImage().redactions;
}

function getTotalPlacements(): number {
  return images.reduce((sum, image) => sum + image.placements.length, 0);
}

function updateSideUI() {
  sideRow.style.display = mode === "vote" ? "flex" : "none";
  voteTargetControls.style.display = mode === "vote" ? "flex" : "none";
  sideLeftBtn.classList.toggle("active", eloSide === "left");
  sideRightBtn.classList.toggle(
    "active",
    eloSide === "right" || eloSide === "me",
  );
  sideOtherBtn.classList.toggle("active", eloSide === "other");

  meCheckLabel.style.display =
    mode === "vote" && (eloSide === "right" || eloSide === "me")
      ? "flex"
      : "none";
  meCheck.checked = meChecked;
  otherRow.style.display =
    mode === "vote" && eloSide === "other" ? "flex" : "none";
}

sideLeftBtn.addEventListener("click", () => {
  eloSide = "left";
  updateSideUI();
});

sideRightBtn.addEventListener("click", () => {
  eloSide = meChecked ? "me" : "right";
  updateSideUI();
});

sideOtherBtn.addEventListener("click", () => {
  eloSide = "other";
  updateSideUI();
});

meCheck.addEventListener("change", () => {
  meChecked = meCheck.checked;
  if (eloSide === "right" || eloSide === "me") {
    eloSide = meChecked ? "me" : "right";
  }
  updateSideUI();
});

otherInput.addEventListener("input", () => {
  const cleaned = sanitizeOtherEloLabel(otherInput.value);
  if (otherInput.value !== cleaned) {
    otherInput.value = cleaned;
  }
});

cmTitle.addEventListener("beforeinput", (event) => {
  const data = event.data ?? "";
  if (data.includes("[") || data.includes("]")) {
    event.preventDefault();
  }
});

cmTitle.addEventListener("input", () => {
  const cleaned = cmTitle.value.replace(TITLE_FORBIDDEN_CHARS_REGEX, "");
  if (cmTitle.value !== cleaned) {
    cmTitle.value = cleaned;
  }
});

function openEditor() {
  applySliderBoundsForMode();
  globalRadius = Number(cmSize.value) || globalRadius;
  markerModeEnabled = false;
  updateMarkerToggleUI();
  document.title = "Creating Texting Theory Post";
  screenMode.style.display = "none";
  createModal.classList.add("open");
  //   hintEl.textContent =
  //     mode === "annotated"
  //       ? "Tap to place a badge by every relevant message. Don't cover anything important."
  //       : "Tap to place a badge by every relevant message. Don't cover anything important.";
  if (isEditSession) {
    hintEl.style.display = "none";
  } else {
    hintEl.style.display = "";
  }
  if (!isEditSession) {
    syncPlacementRadiiFromSlider();
  }
  updateSideUI();
  loadActiveImage(false);
  scheduleEditorLayoutRefresh();
  window.requestAnimationFrame(() => scheduleEditorLayoutRefresh());
  window.setTimeout(() => scheduleEditorLayoutRefresh(), 120);
}

function updateMarkerToggleUI(): void {
  cmMarkerToggle.classList.toggle("active", markerModeEnabled);
  cmCanvasWrap.classList.toggle("marker-mode", markerModeEnabled);
  cmMarkerToggle.setAttribute(
    "aria-label",
    markerModeEnabled ? "Disable redaction marker" : "Enable redaction marker",
  );
}

function updateImageNav() {
  const hasMultiple = images.length > 1;
  cmImageNav.style.display = hasMultiple ? "flex" : "none";
  cmPageChip.style.display = hasMultiple ? "block" : "none";
  cmPageChip.textContent = `${activeImageIndex + 1}/${images.length}`;
  cmImgDots.innerHTML = "";
  for (let index = 0; index < images.length; index++) {
    const dot = document.createElement("div");
    dot.className = "img-dot";
    if (index === activeImageIndex) dot.classList.add("active");
    cmImgDots.appendChild(dot);
  }
  cmImgPrev.style.display = hasMultiple ? "inline-flex" : "none";
  cmImgNext.style.display = hasMultiple ? "inline-flex" : "none";
  cmImgPrev.disabled = !hasMultiple || activeImageIndex <= 0;
  cmImgNext.disabled = !hasMultiple || activeImageIndex >= images.length - 1;
}

cmImageNav.addEventListener("pointerdown", (event) => event.stopPropagation());
cmImageNav.addEventListener("click", (event) => event.stopPropagation());

function updateNextEnabled() {
  const hasAnyPlacements = images.some((img) => img.placements.length > 0);
  cmNext.disabled = !hasAnyPlacements;
  const selected = selectedId;
  if (!selected) {
    cmOrderUp.disabled = true;
    cmOrderDown.disabled = true;
    return;
  }

  const sorted = images
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = sorted.findIndex((placement) => placement.id === selected);
  cmOrderUp.disabled = idx <= 0;
  cmOrderDown.disabled = idx < 0 || idx >= sorted.length - 1;
}

function normalizePlacementOrders(): void {
  const sorted = images
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((placement, index) => {
    placement.order = index;
  });
}

function moveSelectedBadgeOrder(delta: -1 | 1): void {
  if (!selectedId) return;
  const sorted = images
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = sorted.findIndex((placement) => placement.id === selectedId);
  const swapIdx = idx + delta;
  if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;

  const currentOrder = sorted[idx]!.order ?? idx;
  const otherOrder = sorted[swapIdx]!.order ?? swapIdx;
  sorted[idx]!.order = otherOrder;
  sorted[swapIdx]!.order = currentOrder;
  normalizePlacementOrders();
  render();
}

cmOrderUp.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  moveSelectedBadgeOrder(-1);
});

cmOrderDown.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  moveSelectedBadgeOrder(1);
});

cmImgPrev.addEventListener("click", () => {
  navigateToImage(activeImageIndex - 1);
});

cmImgNext.addEventListener("click", () => {
  navigateToImage(activeImageIndex + 1);
});

function navigateToImage(nextIndex: number): void {
  if (
    nextIndex < 0 ||
    nextIndex >= images.length ||
    nextIndex === activeImageIndex
  )
    return;
  if (navTransitionInFlight) {
    queuedNavIndex = nextIndex;
    return;
  }
  startNavigationTo(nextIndex);
}

function startNavigationTo(nextIndex: number): void {
  navTransitionInFlight = true;
  pendingCreateSlideImageSrc = cmImg.currentSrc || cmImg.src || null;
  pendingCreateSlideBadges = {
    badgesHtml: cmBadges.innerHTML,
    badgesLeft: cmBadges.style.left,
    badgesTop: cmBadges.style.top,
    badgesWidth: cmBadges.style.width,
    badgesHeight: cmBadges.style.height,
  };
  imageSlideDirection = nextIndex > activeImageIndex ? "next" : "prev";
  activeImageIndex = nextIndex;
  selectedId = null;
  loadActiveImage();
}

function completeNavigationTransition(): void {
  navTransitionInFlight = false;
  const queued = queuedNavIndex;
  queuedNavIndex = null;
  if (
    queued !== null &&
    queued !== activeImageIndex &&
    queued >= 0 &&
    queued < images.length
  ) {
    startNavigationTo(queued);
  }
}

function loadActiveImage(animate = true) {
  const image = getActiveImage();
  const directionForAnimation = imageSlideDirection;
  const outgoingImageSrc = pendingCreateSlideImageSrc;
  const outgoingBadges = pendingCreateSlideBadges;
  pendingCreateSlideImageSrc = null;
  pendingCreateSlideBadges = null;
  const shouldAnimate =
    animate && !!directionForAnimation && images.length > 1 && !!cmImg.src;

  const finalizeLoadedImage = () => {
    cmImg.src = image.dataUrl;
    render();
    requestAnimationFrame(() => {
      render();
      if (shouldAnimate && directionForAnimation) {
        playCreateSlideAnimation(
          directionForAnimation,
          outgoingImageSrc,
          outgoingBadges,
        );
      } else {
        completeNavigationTransition();
      }
    });
    imageSlideDirection = null;
  };

  const currentUrl = cmImg.currentSrc || cmImg.src;
  if (currentUrl && currentUrl === image.dataUrl) {
    finalizeLoadedImage();
  } else {
    const preloader = new Image();
    preloader.decoding = "async";
    preloader.onload = finalizeLoadedImage;
    preloader.onerror = finalizeLoadedImage;
    preloader.src = image.dataUrl;
  }
  updateImageNav();
}

function playCreateSlideAnimation(
  direction: "prev" | "next",
  outgoingImageSrc: string | null,
  outgoingBadges: {
    badgesHtml: string;
    badgesLeft: string;
    badgesTop: string;
    badgesWidth: string;
    badgesHeight: string;
  } | null,
): void {
  const travelPx = Math.max(
    1,
    cmCanvasWrap.clientWidth || cmCanvasWrap.getBoundingClientRect().width || 1,
  );
  const incomingFromX = direction === "next" ? travelPx : -travelPx;
  const outgoingToX = direction === "next" ? -travelPx : travelPx;
  const durationMs = PAGE_SLIDE_DURATION_MS;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

  let ghostImg: HTMLImageElement | null = null;
  let ghostBadges: HTMLDivElement | null = null;
  if (outgoingImageSrc) {
    ghostImg = document.createElement("img");
    ghostImg.className = "cm-img";
    ghostImg.src = outgoingImageSrc;
    ghostImg.style.position = "absolute";
    ghostImg.style.inset = "0";
    ghostImg.style.zIndex = "2";
    ghostImg.style.transform = "translateX(0)";
    ghostImg.style.pointerEvents = "none";
    cmCanvasWrap.appendChild(ghostImg);
  }

  if (outgoingBadges) {
    ghostBadges = document.createElement("div");
    ghostBadges.className = "cm-badges";
    ghostBadges.style.left = outgoingBadges.badgesLeft;
    ghostBadges.style.top = outgoingBadges.badgesTop;
    ghostBadges.style.width = outgoingBadges.badgesWidth;
    ghostBadges.style.height = outgoingBadges.badgesHeight;
    ghostBadges.style.zIndex = "3";
    ghostBadges.style.pointerEvents = "none";
    ghostBadges.style.transform = "translateX(0)";
    ghostBadges.innerHTML = outgoingBadges.badgesHtml;
    cmCanvasWrap.appendChild(ghostBadges);
  }

  const incomingElements: HTMLElement[] = [cmImg, cmBadges];
  const outgoingElements: HTMLElement[] = [];
  if (ghostImg) outgoingElements.push(ghostImg);
  if (ghostBadges) outgoingElements.push(ghostBadges);

  for (const element of incomingElements) {
    element.style.transition = "none";
    element.style.transform = `translateX(${incomingFromX}px)`;
    void element.offsetWidth;
  }

  if (ghostImg) {
    ghostImg.style.transition = "none";
    ghostImg.style.transform = "translateX(0)";
    void ghostImg.offsetWidth;
  }
  if (ghostBadges) {
    ghostBadges.style.transition = "none";
    ghostBadges.style.transform = "translateX(0)";
    void ghostBadges.offsetWidth;
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

function canvasRect() {
  const wrapRect = cmCanvasWrap.getBoundingClientRect();
  const boxW = wrapRect.width;
  const boxH = wrapRect.height;
  const active = images[activeImageIndex];
  const naturalW = cmImg.naturalWidth || active?.width || cmImg.width || 0;
  const naturalH = cmImg.naturalHeight || active?.height || cmImg.height || 0;

  if (boxW <= 0 || boxH <= 0 || naturalW <= 0 || naturalH <= 0) {
    return {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      imgX: 0,
      imgY: 0,
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
      imgX: 0,
      imgY: 0,
      imgW: 0,
      imgH: 0,
    };
  }

  return {
    x: imgX,
    y: imgY,
    w,
    h,
    imgX,
    imgY,
    imgW: w,
    imgH: h,
  };
}

function render() {
  const r = canvasRect();
  renderRedactions(r);
  cmBadges.style.left = `${r.x}px`;
  cmBadges.style.top = `${r.y}px`;
  cmBadges.style.width = `${r.w}px`;
  cmBadges.style.height = `${r.h}px`;
  cmBadges.innerHTML = "";

  const placements = getActivePlacements();
  const scaleBase = markerScaleBase(r);
  placements.forEach((placement, index) => {
    const el = document.createElement("div");
    el.className = "ed-badge";

    if (mode === "vote") {
      el.classList.add("ed-badge--vote");
    } else {
      el.classList.add("ed-badge--ann");
      if (placement.classification) {
        el.style.backgroundImage = `url(/assets/badges/${placement.classification.toLowerCase()}.png)`;
      }
    }

    if (placement.id === selectedId) el.classList.add("selected");

    const sizePx = (((placement.radius || globalRadius) * 2) / 100) * scaleBase;
    el.style.width = `${sizePx}px`;
    el.style.height = `${sizePx}px`;
    el.style.left = `${placement.x}%`;
    el.style.top = `${placement.y}%`;
    el.dataset.badgeId = placement.id;

    const miniSize = Math.max(12, sizePx * 0.44);
    el.style.setProperty("--mini-size", `${miniSize}px`);
    el.style.setProperty(
      "--mini-del-size",
      `${Math.max(15, miniSize * 1.22)}px`,
    );
    el.style.setProperty(
      "--mini-del-font-size",
      `${Math.max(10, Math.round(miniSize * 0.74))}px`,
    );

    if (mode === "vote") {
      const num = document.createElement("div");
      num.className = "ed-num";
      num.style.fontSize = `${Math.max(9.5, miniSize * 0.68)}px`;
      const order = placement.order ?? index;
      num.textContent = String(order + 1);
      el.appendChild(num);
    }

    if (placement.id === selectedId) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ed-del";
      del.textContent = "✕";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = getActivePlacements().filter((p) => p.id !== placement.id);
        getActiveImage().placements = next;
        normalizePlacementOrders();
        selectedId = null;
        render();
      });
      el.appendChild(del);
    }

    el.addEventListener("pointerdown", (event) =>
      onBadgePointerDown(event, placement),
    );
    el.addEventListener("click", (event) => {
      if (markerModeEnabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      const wasSelected = selectedId === placement.id;
      selectBadge(placement.id);
      if (mode === "annotated") {
        if (wasSelected && Date.now() >= suppressEditorPickerUntil) {
          openClassPicker(placement, false);
        }
      }
    });

    cmBadges.appendChild(el);
  });

  updateNextEnabled();
}

function selectBadge(id: string | null) {
  selectedId = id;
  render();
}

function clampPlacementCenter(
  px: number,
  py: number,
  sizePx: number,
  rect: ReturnType<typeof canvasRect>,
): { x: number; y: number } {
  const half = sizePx / 2;
  const minInsideHalf = half - sizePx / 3;
  const minX = rect.imgX + minInsideHalf;
  const maxX = rect.imgX + rect.imgW - minInsideHalf;
  const minY = rect.imgY + minInsideHalf;
  const maxY = rect.imgY + rect.imgH - minInsideHalf;
  return {
    x: Math.min(maxX, Math.max(minX, px)),
    y: Math.min(maxY, Math.max(minY, py)),
  };
}

cmCanvasWrap.addEventListener("click", (event) => {
  if (markerModeEnabled) return;
  if (Date.now() < suppressEditorPickerUntil) return;
  const target = event.target as HTMLElement;
  if (target.closest(".ed-badge")) return;
  if (target.closest(".image-nav")) return;

  const r = canvasRect();
  const rect = cmCanvasWrap.getBoundingClientRect();
  const cx = event.clientX - rect.left;
  const cy = event.clientY - rect.top;

  if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) return;

  const x = ((cx - r.x) / r.w) * 100;
  const y = ((cy - r.y) / r.h) * 100;
  const id = `b${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const nextOrder =
    images
      .flatMap((image) => image.placements)
      .reduce((max, placement) => Math.max(max, placement.order ?? -1), -1) + 1;

  const p: BadgePlacement = {
    id,
    x,
    y,
    radius: mapUniformRadiusToImageRadius(globalRadius, activeImageIndex),
    order: nextOrder,
    classification: undefined,
  };

  const sizePx = ((p.radius * 2) / 100) * markerScaleBase(r);
  const px = r.x + (x / 100) * r.w;
  const py = r.y + (y / 100) * r.h;
  const clamped = clampPlacementCenter(px, py, sizePx, r);
  p.x = ((clamped.x - r.x) / r.w) * 100;
  p.y = ((clamped.y - r.y) / r.h) * 100;

  if (mode === "annotated") {
    pendingNewAnnotation = p;
    openClassPicker(p, true);
  } else {
    getActivePlacements().push(p);
    normalizePlacementOrders();
    selectedId = id;
    hintEl.classList.add("hidden");
    render();
  }
});

function onBadgePointerDown(event: PointerEvent, placement: BadgePlacement) {
  if (markerModeEnabled) return;
  event.preventDefault();
  event.stopPropagation();
  pointerState = {
    badgeId: placement.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
}

function onPointerMove(event: PointerEvent) {
  if (!pointerState || pointerState.pointerId !== event.pointerId) return;
  const placements = getActivePlacements();
  const dragPlacement = placements.find((p) => p.id === pointerState!.badgeId);
  if (!dragPlacement) return;

  const dx = event.clientX - pointerState.startX;
  const dy = event.clientY - pointerState.startY;
  if (!pointerState.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
  pointerState.moved = true;
  selectedId = dragPlacement.id;

  const rect = cmCanvasWrap.getBoundingClientRect();

  const r = canvasRect();
  let px = event.clientX - rect.left;
  let py = event.clientY - rect.top;
  px = Math.max(r.x, Math.min(px, r.x + r.w));
  py = Math.max(r.y, Math.min(py, r.y + r.h));

  dragPlacement.x = ((px - r.x) / r.w) * 100;
  dragPlacement.y = ((py - r.y) / r.h) * 100;

  const sizePx =
    (((dragPlacement.radius || globalRadius) * 2) / 100) * markerScaleBase(r);
  const clamped = clampPlacementCenter(px, py, sizePx, r);
  dragPlacement.x = ((clamped.x - r.x) / r.w) * 100;
  dragPlacement.y = ((clamped.y - r.y) / r.h) * 100;

  render();
}

function onPointerUp(event: PointerEvent) {
  pointerState = null;
  window.removeEventListener("pointermove", onPointerMove);
}

function toImagePercentPoint(event: PointerEvent): RedactionPoint | null {
  const r = canvasRect();
  const rect = cmCanvasWrap.getBoundingClientRect();
  let px = event.clientX - rect.left;
  let py = event.clientY - rect.top;

  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return null;
  px = Math.max(r.x, Math.min(px, r.x + r.w));
  py = Math.max(r.y, Math.min(py, r.y + r.h));
  return {
    x: ((px - r.x) / r.w) * 100,
    y: ((py - r.y) / r.h) * 100,
  };
}

function renderRedactions(rect: ReturnType<typeof canvasRect>): void {
  cmRedactLayer.style.left = `${rect.x}px`;
  cmRedactLayer.style.top = `${rect.y}px`;
  cmRedactLayer.style.width = `${rect.w}px`;
  cmRedactLayer.style.height = `${rect.h}px`;

  const drawW = Math.max(1, Math.round(rect.w));
  const drawH = Math.max(1, Math.round(rect.h));
  if (cmRedactLayer.width !== drawW) cmRedactLayer.width = drawW;
  if (cmRedactLayer.height !== drawH) cmRedactLayer.height = drawH;

  const ctx = cmRedactLayer.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, cmRedactLayer.width, cmRedactLayer.height);
  drawRedactionsOnContext(
    ctx,
    getActiveRedactions(),
    cmRedactLayer.width,
    cmRedactLayer.height,
  );
}

function drawRedactionsOnContext(
  ctx: CanvasRenderingContext2D,
  redactions: RedactionStroke[],
  width: number,
  height: number,
): void {
  const scaleBase = Math.max(width, height);
  ctx.strokeStyle = "#0b0b0b";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of redactions) {
    if (!stroke.points.length) continue;
    ctx.lineWidth =
      ((stroke.widthPct || REDACTION_STROKE_WIDTH_PCT) / 100) * scaleBase;
    ctx.beginPath();
    const first = stroke.points[0]!;
    ctx.moveTo((first.x / 100) * width, (first.y / 100) * height);
    for (let index = 1; index < stroke.points.length; index++) {
      const point = stroke.points[index]!;
      ctx.lineTo((point.x / 100) * width, (point.y / 100) * height);
    }
    if (stroke.points.length === 1) {
      const point = stroke.points[0]!;
      const radius = Math.max(1, ctx.lineWidth / 2);
      ctx.moveTo((point.x / 100) * width + radius, (point.y / 100) * height);
      ctx.arc(
        (point.x / 100) * width,
        (point.y / 100) * height,
        radius,
        0,
        Math.PI * 2,
      );
    }
    ctx.stroke();
  }
}

function onMarkerPointerMove(event: PointerEvent): void {
  if (
    !markerModeEnabled ||
    drawingPointerId !== event.pointerId ||
    !activeStroke
  )
    return;
  event.preventDefault();
  const point = toImagePercentPoint(event);
  if (!point) return;
  const last = activeStroke.points[activeStroke.points.length - 1];
  if (
    last &&
    Math.abs(last.x - point.x) < 0.08 &&
    Math.abs(last.y - point.y) < 0.08
  )
    return;
  activeStroke.points.push(point);
  render();
}

function onMarkerPointerUp(event: PointerEvent): void {
  if (drawingPointerId !== event.pointerId) return;
  drawingPointerId = null;
  activeStroke = null;
  window.removeEventListener("pointermove", onMarkerPointerMove);
  window.removeEventListener("pointerup", onMarkerPointerUp);
  window.removeEventListener("pointercancel", onMarkerPointerUp);
}

cmCanvasWrap.addEventListener("pointerdown", (event) => {
  if (!markerModeEnabled) return;
  const target = event.target as HTMLElement;
  if (target.closest("#cm-marker-toggle")) return;
  if (target.closest(".image-nav")) return;

  const point = toImagePercentPoint(event);
  if (!point) return;

  event.preventDefault();
  event.stopPropagation();
  hintEl.classList.add("hidden");
  selectedId = null;

  const stroke: RedactionStroke = {
    points: [point],
    widthPct: REDACTION_STROKE_WIDTH_PCT,
  };
  getActiveRedactions().push(stroke);
  activeStroke = stroke;
  drawingPointerId = event.pointerId;

  window.addEventListener("pointermove", onMarkerPointerMove);
  window.addEventListener("pointerup", onMarkerPointerUp);
  window.addEventListener("pointercancel", onMarkerPointerUp);
  render();
});

cmMarkerToggle.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  markerModeEnabled = !markerModeEnabled;
  selectedId = null;
  updateMarkerToggleUI();
  render();
});

cmMarkerToggle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});

cmSize.addEventListener("input", () => {
  globalRadius = Number(cmSize.value);
  syncPlacementRadiiFromSlider();
  render();
});

cmImg.addEventListener("load", () => {
  scheduleEditorLayoutRefresh();
});

cmNext.addEventListener("click", () => {
  if (cmNext.disabled) return;
  if (isEditSession) {
    void submitEditSession();
    return;
  }
  if (getTotalPlacements() === 1) {
    singleBadgeModal.classList.add("open");
    return;
  }
  sideRow.style.display = "flex";
  otherRow.style.display =
    mode === "vote" && eloSide === "other" ? "flex" : "none";
  detailsModal.classList.add("open");
  updateSideUI();
});

singleBadgeBg.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
});

singleBadgeCancel.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
});

singleBadgeContinue.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
  sideRow.style.display = "flex";
  otherRow.style.display =
    mode === "vote" && eloSide === "other" ? "flex" : "none";
  detailsModal.classList.add("open");
  updateSideUI();
});

detailsBg.addEventListener("click", () =>
  detailsModal.classList.remove("open"),
);

async function submitEditSession(): Promise<void> {
  if (!isEditSession || isSubmitting) return;
  if (!images.length) {
    alert("Add at least one image.");
    return;
  }
  const hasAnyPlacements = images.some((img) => img.placements.length > 0);
  if (!hasAnyPlacements) {
    alert("Add at least one badge.");
    return;
  }

  normalizePlacementOrders();

  submitOvl.style.display = "flex";
  submitText.textContent = "Saving edits…";
  isSubmitting = true;

  try {
    const payloadImages = await Promise.all(
      images.map((img) => flattenVoteImage(img)),
    );
    const body: UpdatePostRequest = {
      images: payloadImages,
    };

    const res = await fetch(ApiEndpoint.UpdatePost, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Update failed" }));
      throw new Error((err as { error?: string }).error ?? "Update failed");
    }

    const data = (await res.json()) as UpdatePostResponse;
    submitText.textContent = "Edits saved";
    await new Promise((resolve) => setTimeout(resolve, 180));
    try {
      navigateTo(data.postUrl);
    } catch {
      window.location.href = data.postUrl;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save edits";
    alert(message);
  } finally {
    submitOvl.style.display = "none";
    isSubmitting = false;
  }
}

cmPost.addEventListener("click", async () => {
  if (isEditSession) {
    await submitEditSession();
    return;
  }

  if (isSubmitting) return;
  if (!images.length) {
    alert("Add at least one image.");
    return;
  }

  const hasAnyPlacements = images.some((img) => img.placements.length > 0);
  if (!hasAnyPlacements) {
    alert("Add at least one badge.");
    return;
  }

  let title = cmTitle.value.trim();
  title = title.replace(TITLE_FORBIDDEN_CHARS_REGEX, "").trim();
  cmTitle.value = title;
  if (!title) {
    alert("Please enter a title.");
    cmTitle.focus();
    return;
  }

  if (mode === "annotated" && !title.startsWith("[Annotated] ")) {
    title = `[Annotated] ${title}`;
  }

  let effectiveSide: EloSide | undefined;
  let eloOtherText: string | undefined;

  if (mode === "vote") {
    effectiveSide = eloSide;
    if (eloSide === "right" || eloSide === "me") {
      effectiveSide = meChecked ? "me" : "right";
    }

    if (effectiveSide === "other") {
      const txtRaw = sanitizeOtherEloLabel(otherInput.value.trim());
      const isMeAlias = /^me$/i.test(txtRaw);
      if (isMeAlias) {
        otherInput.value = "Me";
        meChecked = true;
        effectiveSide = "me";
      }

      const txt = isMeAlias ? "Me" : txtRaw;
      otherInput.value = txt;
      if (!isMeAlias && !txt) {
        alert("Enter who this Elo vote should target (letters only).");
        otherInput.focus();
        return;
      }
      if (!isMeAlias && !OTHER_ELO_LABEL_REGEX.test(txt)) {
        alert("Other target must be letters only, max 16 characters.");
        otherInput.focus();
        return;
      }
      eloOtherText = isMeAlias ? undefined : txt;
    }

    if (!title.startsWith("[")) {
      if (effectiveSide === "me") title = `[Me] ${title}`;
      else if (effectiveSide === "left") title = `[Left] ${title}`;
      else if (effectiveSide === "other") title = `[${eloOtherText}] ${title}`;
      else title = `[Right] ${title}`;
    }
  }

  submitOvl.style.display = "flex";
  submitText.textContent = "Creating post…";
  isSubmitting = true;

  try {
    const payloadImages =
      mode === "annotated"
        ? [await flattenAnnotatedImage(images[0]!)]
        : await Promise.all(images.map((img) => flattenVoteImage(img)));

    const body: CreatePostRequest = {
      title,
      mode,
      images: payloadImages,
      eloSide: mode === "vote" ? effectiveSide : undefined,
      eloOtherText: mode === "vote" ? eloOtherText : undefined,
    };

    const res = await fetch(ApiEndpoint.CreatePost, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      const message = (err as { error?: string }).error ?? "Unknown";
      if (
        mode === "annotated" &&
        /asynchronously|could not be resolved yet/i.test(message)
      ) {
        submitText.textContent =
          "Post submitted. Reddit is still finalizing it…";
        await new Promise((resolve) => setTimeout(resolve, 120));
        detailsModal.classList.remove("open");
        createModal.classList.remove("open");
        screenMode.style.display = "flex";
        try {
          navigateTo("https://www.reddit.com/new/");
        } catch {
          window.location.href = "https://www.reddit.com/new/";
        }
        return;
      }
      alert(`Error: ${message}`);
      submitOvl.style.display = "none";
      isSubmitting = false;
      return;
    }

    const data = (await res.json()) as CreatePostResponse;
    if (data.postUrl) {
      const unresolvedAnnotated =
        mode === "annotated" && data.postId.startsWith("pending-");
      submitText.textContent = unresolvedAnnotated
        ? "Post submitted. Reddit is still finalizing it…"
        : "Post created successfully";
      await new Promise((resolve) =>
        setTimeout(resolve, unresolvedAnnotated ? 120 : 250),
      );
      detailsModal.classList.remove("open");
      createModal.classList.remove("open");
      screenMode.style.display = "flex";
      try {
        navigateTo(data.postUrl);
      } catch {
        try {
          if (window.top) {
            window.top.location.href = data.postUrl;
          } else {
            window.location.href = data.postUrl;
          }
        } catch {
          window.location.href = data.postUrl;
        }
      }
      return;
    }

    alert("Post created.");
    window.location.reload();
  } catch (err) {
    console.error(err);
    alert("Failed to post.");
    submitOvl.style.display = "none";
    isSubmitting = false;
  } finally {
    if (submitOvl.style.display !== "none") {
      submitOvl.style.display = "none";
    }
    isSubmitting = false;
  }
});

function isBookValid(p: BadgePlacement): boolean {
  const allPlacements = images
    .flatMap((image) => image.placements)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const existingIdx = allPlacements.findIndex(
    (placement) => placement.id === p.id,
  );
  if (existingIdx >= 0) {
    if (existingIdx === 0) return true;
    const prev = allPlacements[existingIdx - 1];
    return !!prev && prev.classification === Classification.BOOK;
  }

  const prev = allPlacements[allPlacements.length - 1];
  if (!prev) return true;
  return prev.classification === Classification.BOOK;
}

function openClassPicker(p: BadgePlacement, isNew: boolean) {
  pickerTitle.textContent = "Choose Classification";
  pickerBody.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "pk-grid";

  const bookValid = isBookValid(p);

  for (const cls of PICKER_CLASSIFICATIONS) {
    const isBookDisabled =
      mode === "vote" && cls === Classification.BOOK && !bookValid;
    const item = createPickerItem(cls, p, isBookDisabled, isNew);
    grid.appendChild(item);
  }

  pickerBody.appendChild(grid);
  pickerModal.classList.add("open");
}

function createPickerItem(
  cls: Classification,
  p: BadgePlacement,
  disabled: boolean,
  isNew: boolean,
) {
  const info = BADGE_INFO[cls];
  const hint = BADGE_HINTS[cls];
  const item = document.createElement("div");
  item.className = "pk-item";
  if (p.classification === cls) item.classList.add("active");
  if (disabled) item.classList.add("disabled");

  const icon = document.createElement("div");
  icon.className = "pk-icon";
  icon.style.backgroundImage = `url(/assets/badges/${cls.toLowerCase()}.png)`;

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

  item.addEventListener("click", () => {
    if (disabled) return;
    p.classification = cls;
    if (isNew && pendingNewAnnotation) {
      getActivePlacements().push(pendingNewAnnotation);
      selectedId = pendingNewAnnotation.id;
      pendingNewAnnotation = null;
      hintEl.classList.add("hidden");
    }
    closePicker();
    render();
  });

  return item;
}

let activeHintEl: HTMLDivElement | null = null;

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
  if (left < 8) left = 8;
  if (left + pr.width > window.innerWidth - 8)
    left = window.innerWidth - pr.width - 8;

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
  pickerModal.classList.remove("open");
  pendingNewAnnotation = null;
  closeHint();
}

pickerBg.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  suppressEditorPickerUntil = Date.now() + 450;
  closePicker();
});
pickerBg.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  suppressEditorPickerUntil = Date.now() + 450;
  closePicker();
});
window.addEventListener("resize", () => {
  scheduleEditorLayoutRefresh();
});

if (typeof ResizeObserver !== "undefined") {
  const editorResizeObserver = new ResizeObserver(() => {
    scheduleEditorLayoutRefresh();
  });
  editorResizeObserver.observe(cmCanvasWrap);
}

updateNextEnabled();

async function toDownscaledData(file: File): Promise<{
  dataUrl: string;
  base64: string;
  mime: string;
  width: number;
  height: number;
}> {
  const originalDataUrl = await readAsDataUrl(file);
  const image = await loadImage(originalDataUrl);

  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(srcW, srcH));
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d");
  if (!ctx)
    return {
      dataUrl: originalDataUrl,
      base64: originalDataUrl.split(",")[1] ?? "",
      mime: file.type || "image/jpeg",
      width: srcW,
      height: srcH,
    };

  ctx.drawImage(image, 0, 0, outW, outH);

  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(
    mime,
    mime === "image/jpeg" ? 0.98 : undefined,
  );

  return {
    dataUrl,
    base64: dataUrl.split(",")[1] ?? "",
    mime,
    width: outW,
    height: outH,
  };
}

async function flattenAnnotatedImage(image: EditorImage): Promise<{
  imageData: string;
  imageMimeType: string;
  imageWidth: number;
  imageHeight: number;
  placements: BadgePlacement[];
}> {
  const base = await loadImage(image.dataUrl);
  const width = image.width || base.naturalWidth || base.width;
  const height = image.height || base.naturalHeight || base.height;
  const longSide = Math.max(width, height);
  const exportScale = Math.max(1, ANNOTATED_EXPORT_MIN_LONG_SIDE / longSide);
  const exportWidth = Math.max(1, Math.round(width * exportScale));
  const exportHeight = Math.max(1, Math.round(height * exportScale));
  const canvas = document.createElement("canvas");
  canvas.width = exportWidth;
  canvas.height = exportHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      imageData: image.base64,
      imageMimeType: image.mime,
      imageWidth: image.width,
      imageHeight: image.height,
      placements: [],
    };
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  drawRedactionsOnContext(ctx, image.redactions, canvas.width, canvas.height);
  const scaleBase = Math.max(canvas.width, canvas.height);
  const ordered = image.placements
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const placement of ordered) {
    if (!placement.classification) continue;
    const badge = await loadImage(
      `/assets/badges/${placement.classification.toLowerCase()}.png`,
    );
    const diameter = ((placement.radius || globalRadius) * 2 * scaleBase) / 100;
    const centerX = (placement.x / 100) * canvas.width;
    const centerY = (placement.y / 100) * canvas.height;
    ctx.drawImage(
      badge,
      centerX - diameter / 2,
      centerY - diameter / 2,
      diameter,
      diameter,
    );
  }

  const mime = "image/png";
  const dataUrl = canvas.toDataURL(mime);
  return {
    imageData: dataUrl.split(",")[1] ?? "",
    imageMimeType: mime,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    placements: [],
  };
}

async function flattenVoteImage(image: EditorImage): Promise<{
  imageData: string;
  imageMimeType: string;
  imageWidth: number;
  imageHeight: number;
  placements: BadgePlacement[];
}> {
  const base = await loadImage(image.dataUrl);
  const width = image.width || base.naturalWidth || base.width;
  const height = image.height || base.naturalHeight || base.height;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      imageData: image.base64,
      imageMimeType: image.mime,
      imageWidth: image.width,
      imageHeight: image.height,
      placements: image.placements,
    };
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  drawRedactionsOnContext(ctx, image.redactions, canvas.width, canvas.height);

  const mime = "image/png";
  const dataUrl = canvas.toDataURL(mime);
  return {
    imageData: dataUrl.split(",")[1] ?? "",
    imageMimeType: mime,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    placements: image.placements,
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

void initEditSessionIfRequested();
