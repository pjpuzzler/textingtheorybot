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
const VOTE_MIN_RADIUS = 2.7;
const VOTE_MAX_RADIUS = 5.8;
const ANNOTATED_MIN_RADIUS = 2.7;
const ANNOTATED_MAX_RADIUS = 5.8;
const ANNOTATED_EXPORT_MIN_LONG_SIDE = 1280;
const REDACTION_STROKE_WIDTH_PCT = 1.25;
const PAGE_SLIDE_DURATION_MS = 150;
const MIN_CROP_SIZE_PCT = 8;
const EDITOR_PICKER_BACKDROP_GUARD_MS = 900;

let mode: PostMode = "vote";
let selectedId: string | null = null;
let globalRadius = 6;
let lastUsedRadius = 6;
let imageRadiusByIndex: number[] = [];
let imageRadiusTouchedByIndex: boolean[] = [];
let eloSide: EloSide = "right";
let meChecked = true;
let cropApplying = false;
let createCropFlowActive = false;
let createCropFlowIndex = 0;
let cropSelection = { left: 0, top: 0, right: 100, bottom: 100 };
let activeCropHandle: "tl" | "tr" | "bl" | "br" | null = null;
let cropMarkerModeEnabled = false;
let cropDrawingPointerId: number | null = null;
let cropActiveStroke: RedactionStroke | null = null;
let cropWorkingImage: EditorImage | null = null;
let cropOriginalImage: EditorImage | null = null;
let cropAutoZoomTimer: number | null = null;
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
let sliderVisualFrame = 0;
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
const cmCrop = $("cm-crop") as HTMLButtonElement;
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
const missingImageModal = $("missing-image-modal") as HTMLDivElement;
const missingImageBg = $("missing-image-bg") as HTMLDivElement;
const missingImageCancel = $("missing-image-cancel") as HTMLButtonElement;
const missingImageContinue = $("missing-image-continue") as HTMLButtonElement;

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

const cropModal = $("crop-modal") as HTMLDivElement;
const cropBg = $("crop-bg") as HTMLDivElement;
const cropStep = $("crop-step") as HTMLDivElement;
const cropPreviewWrap = $("crop-preview-wrap") as HTMLDivElement;
const cropPreview = $("crop-preview") as HTMLImageElement;
const cropRedactLayer = $("crop-redact-layer") as HTMLCanvasElement;
const cropBadges = $("crop-badges") as HTMLDivElement;
const cropMask = $("crop-mask") as HTMLDivElement;
const cropMaskTop = $("crop-mask-top") as HTMLDivElement;
const cropMaskRight = $("crop-mask-right") as HTMLDivElement;
const cropMaskBottom = $("crop-mask-bottom") as HTMLDivElement;
const cropMaskLeft = $("crop-mask-left") as HTMLDivElement;
const cropMarkerToggle = $("crop-marker-toggle") as HTMLButtonElement;
const cropBox = $("crop-box") as HTMLDivElement;
const cropHandleTl = $("crop-handle-tl") as HTMLButtonElement;
const cropHandleTr = $("crop-handle-tr") as HTMLButtonElement;
const cropHandleBl = $("crop-handle-bl") as HTMLButtonElement;
const cropHandleBr = $("crop-handle-br") as HTMLButtonElement;
const cropReset = $("crop-reset") as HTMLButtonElement;
const cropCancel = $("crop-cancel") as HTMLButtonElement;
const cropApply = $("crop-apply") as HTMLButtonElement;

let pendingNewAnnotation: BadgePlacement | null = null;
let suppressEditorPickerUntil = 0;

function resetTransientOverlays(): void {
  pickerModal.classList.remove("open");
  detailsModal.classList.remove("open");
  singleBadgeModal.classList.remove("open");
  missingImageModal.classList.remove("open");
  cropModal.classList.remove("open");
  if (!isSubmitting && !isEditBootRequested) {
    submitOvl.style.display = "none";
  }
}

resetTransientOverlays();
window.addEventListener("pageshow", () => {
  resetTransientOverlays();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    resetTransientOverlays();
  }
});
window.addEventListener("focus", () => {
  resetTransientOverlays();
});
let suppressEditorPickerBackdropUntil = 0;

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
} else {
  document.documentElement.classList.remove("tt-edit-boot");
  submitOvl.style.display = "none";
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
lastUsedRadius = globalRadius;

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
  lastUsedRadius = clampGlobalRadius(globalRadius);
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
  return imageScaleBaseForDimensions(image.width || 1, image.height || 1);
}

function imageScaleBaseForDimensions(width: number, height: number): number {
  const box = editorBoxSize();
  const iw = Math.max(1, width || 1);
  const ih = Math.max(1, height || 1);
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

function mapUniformRadiusToImageRadiusForBase(
  baseRadius: number,
  imageBase: number,
): number {
  const uniformBase = editorUniformScaleBase();
  const diameterPx = ((baseRadius * 2) / 100) * uniformBase;
  return (diameterPx / Math.max(1, imageBase)) * 50;
}

function mapImageRadiusToUniformRadiusForBase(
  imageRadius: number,
  imageBase: number,
): number {
  const uniformBase = editorUniformScaleBase();
  return (imageRadius * Math.max(1, imageBase)) / Math.max(1, uniformBase);
}

function mapImageRadiusToUniformRadius(
  imageRadius: number,
  index: number,
): number {
  const uniformBase = editorUniformScaleBase();
  const imageBase = imageScaleBaseForIndex(index);
  return (imageRadius * imageBase) / Math.max(1, uniformBase);
}

function clampGlobalRadius(value: number): number {
  const min = sliderMinForMode();
  const max = sliderMaxForMode();
  return Math.min(max, Math.max(min, value));
}

function resetPerImageRadiusState(): void {
  const initialRadius = clampGlobalRadius(Number(cmSize.value) || globalRadius);
  globalRadius = initialRadius;
  lastUsedRadius = initialRadius;
  imageRadiusByIndex = images.map(() => initialRadius);
  imageRadiusTouchedByIndex = images.map(() => false);
}

function syncSliderForActiveImage(): void {
  const activeImage = images[activeImageIndex];
  if (!activeImage) return;
  const hasCustom = imageRadiusTouchedByIndex[activeImageIndex] === true;
  let nextRadius = hasCustom ? imageRadiusByIndex[activeImageIndex] : undefined;
  if (!hasCustom) {
    const existingPlacement = activeImage.placements[0];
    if (existingPlacement?.radius != null) {
      nextRadius = mapImageRadiusToUniformRadius(
        existingPlacement.radius,
        activeImageIndex,
      );
    }
  }
  if (nextRadius == null) {
    nextRadius = lastUsedRadius;
  }
  const clamped = clampGlobalRadius(nextRadius ?? globalRadius);
  globalRadius = clamped;
  if (!hasCustom) {
    imageRadiusByIndex[activeImageIndex] = clamped;
  }
  cmSize.value = String(clamped);
}

function markerScaleBase(rect: ReturnType<typeof canvasRect>): number {
  return Math.max(rect.imgW, rect.imgH);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function cropPreviewRect(): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const boxW = cropPreviewWrap.clientWidth;
  const boxH = cropPreviewWrap.clientHeight;
  const target = cropWorkingImage ?? getActiveImage();
  const naturalW = cropPreview.naturalWidth || target?.width || 0;
  const naturalH = cropPreview.naturalHeight || target?.height || 0;
  if (boxW <= 0 || boxH <= 0 || naturalW <= 0 || naturalH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(boxW / naturalW, boxH / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return {
    x: (boxW - w) / 2,
    y: (boxH - h) / 2,
    w,
    h,
  };
}

function renderCropSelection(): void {
  const r = cropPreviewRect();
  if (r.w <= 0 || r.h <= 0) return;
  const leftPx = r.x + (cropSelection.left / 100) * r.w;
  const topPx = r.y + (cropSelection.top / 100) * r.h;
  const rightPx = r.x + (cropSelection.right / 100) * r.w;
  const bottomPx = r.y + (cropSelection.bottom / 100) * r.h;
  cropBox.style.left = `${leftPx}px`;
  cropBox.style.top = `${topPx}px`;
  cropBox.style.width = `${Math.max(1, rightPx - leftPx)}px`;
  cropBox.style.height = `${Math.max(1, bottomPx - topPx)}px`;

  const drawW = Math.max(1, Math.round(r.w));
  const drawH = Math.max(1, Math.round(r.h));
  cropRedactLayer.style.left = `${r.x}px`;
  cropRedactLayer.style.top = `${r.y}px`;
  cropRedactLayer.style.width = `${r.w}px`;
  cropRedactLayer.style.height = `${r.h}px`;
  if (cropRedactLayer.width !== drawW) cropRedactLayer.width = drawW;
  if (cropRedactLayer.height !== drawH) cropRedactLayer.height = drawH;
  cropBadges.style.left = `${r.x}px`;
  cropBadges.style.top = `${r.y}px`;
  cropBadges.style.width = `${r.w}px`;
  cropBadges.style.height = `${r.h}px`;
  cropMask.style.left = `${r.x}px`;
  cropMask.style.top = `${r.y}px`;
  cropMask.style.width = `${r.w}px`;
  cropMask.style.height = `${r.h}px`;

  const cropX = Math.max(0, leftPx - r.x);
  const cropY = Math.max(0, topPx - r.y);
  const cropW = Math.max(1, rightPx - leftPx);
  const cropH = Math.max(1, bottomPx - topPx);

  cropMaskTop.style.left = "0px";
  cropMaskTop.style.top = "0px";
  cropMaskTop.style.width = `${r.w}px`;
  cropMaskTop.style.height = `${Math.max(0, cropY)}px`;

  cropMaskBottom.style.left = "0px";
  cropMaskBottom.style.top = `${Math.max(0, cropY + cropH)}px`;
  cropMaskBottom.style.width = `${r.w}px`;
  cropMaskBottom.style.height = `${Math.max(0, r.h - (cropY + cropH))}px`;

  cropMaskLeft.style.left = "0px";
  cropMaskLeft.style.top = `${Math.max(0, cropY)}px`;
  cropMaskLeft.style.width = `${Math.max(0, cropX)}px`;
  cropMaskLeft.style.height = `${Math.max(0, cropH)}px`;

  cropMaskRight.style.left = `${Math.max(0, cropX + cropW)}px`;
  cropMaskRight.style.top = `${Math.max(0, cropY)}px`;
  cropMaskRight.style.width = `${Math.max(0, r.w - (cropX + cropW))}px`;
  cropMaskRight.style.height = `${Math.max(0, cropH)}px`;

  const target = cropWorkingImage ?? getActiveImage();
  cropBadges.innerHTML = "";
  if (target) {
    const scaleBase = Math.max(r.w, r.h);
    for (const placement of target.placements) {
      const el = document.createElement("div");
      el.className = "crop-badge";
      const key = placement.classification
        ? placement.classification.toLowerCase()
        : "unknown";
      el.style.backgroundImage = `url(/assets/badges/${key}.png)`;
      const radius =
        placement.radius ??
        mapUniformRadiusToImageRadius(globalRadius, activeImageIndex);
      const sizePx = ((radius * 2) / 100) * scaleBase;
      el.style.width = `${sizePx}px`;
      el.style.height = `${sizePx}px`;
      el.style.left = `${placement.x}%`;
      el.style.top = `${placement.y}%`;
      cropBadges.appendChild(el);
    }
  }

  const ctx = cropRedactLayer.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, cropRedactLayer.width, cropRedactLayer.height);
    const redactions = target?.redactions ?? [];
    drawRedactionsOnContext(
      ctx,
      redactions,
      cropRedactLayer.width,
      cropRedactLayer.height,
    );
  }
}

function resetCropSelection(): void {
  cropSelection = { left: 0, top: 0, right: 100, bottom: 100 };
  renderCropSelection();
}

function updateCropFlowUI(): void {
  if (createCropFlowActive) {
    cropStep.textContent = `Image ${createCropFlowIndex + 1}/${images.length}`;
    cropApply.textContent =
      createCropFlowIndex >= images.length - 1 ? "Start tagging" : "Next image";
    cropCancel.textContent = "Cancel";
  } else {
    cropStep.textContent = "";
    cropApply.textContent = "Apply";
    cropCancel.textContent = "Cancel";
  }
}

function openCropModalForActiveImage(): void {
  if (!images.length) return;
  cropOriginalImage = cloneEditorImage(getActiveImage());
  cropWorkingImage = cloneEditorImage(getActiveImage());
  cropPreview.src = cropWorkingImage.dataUrl;
  cropMarkerModeEnabled = false;
  updateCropMarkerUI();
  resetCropSelection();
  updateCropFlowUI();
  cropModal.classList.add("open");
  requestAnimationFrame(() => renderCropSelection());
}

function closeCropModal(): void {
  cropModal.classList.remove("open");
  activeCropHandle = null;
  cropDrawingPointerId = null;
  cropActiveStroke = null;
  if (cropAutoZoomTimer !== null) {
    window.clearTimeout(cropAutoZoomTimer);
    cropAutoZoomTimer = null;
  }
}

function getCropTargetRedactions(): RedactionStroke[] {
  return (cropWorkingImage ?? getActiveImage()).redactions;
}

function scheduleCropAutoZoom(): void {
  if (cropAutoZoomTimer !== null) {
    window.clearTimeout(cropAutoZoomTimer);
  }
  cropAutoZoomTimer = window.setTimeout(() => {
    cropAutoZoomTimer = null;
    if (!cropModal.classList.contains("open") || !cropWorkingImage) return;
    if (
      cropSelection.left === 0 &&
      cropSelection.top === 0 &&
      cropSelection.right === 100 &&
      cropSelection.bottom === 100
    ) {
      return;
    }
    void (async () => {
      await cropImageInPlace(cropWorkingImage!, cropSelection);
      resetCropSelection();
      cropPreview.src = cropWorkingImage!.dataUrl;
      renderCropSelection();
    })();
  }, 700);
}

function updateCropMarkerUI(): void {
  cropMarkerToggle.classList.toggle("active", cropMarkerModeEnabled);
  cropPreviewWrap.classList.toggle("marker-mode", cropMarkerModeEnabled);
  cropMarkerToggle.setAttribute(
    "aria-label",
    cropMarkerModeEnabled
      ? "Disable redaction marker"
      : "Enable redaction marker",
  );
}

function cropEventToImagePercent(event: PointerEvent): RedactionPoint | null {
  const r = cropPreviewRect();
  if (r.w <= 0 || r.h <= 0) return null;
  const wrapRect = cropPreviewWrap.getBoundingClientRect();
  const px = event.clientX - wrapRect.left - cropPreviewWrap.clientLeft;
  const py = event.clientY - wrapRect.top - cropPreviewWrap.clientTop;
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) {
    return null;
  }
  return {
    x: ((px - r.x) / r.w) * 100,
    y: ((py - r.y) / r.h) * 100,
  };
}

function onCropMarkerPointerMove(event: PointerEvent): void {
  if (
    !cropMarkerModeEnabled ||
    cropDrawingPointerId !== event.pointerId ||
    !cropActiveStroke
  ) {
    return;
  }
  event.preventDefault();
  const point = cropEventToImagePercent(event);
  if (!point) return;
  const last = cropActiveStroke.points[cropActiveStroke.points.length - 1];
  if (
    last &&
    Math.abs(last.x - point.x) < 0.08 &&
    Math.abs(last.y - point.y) < 0.08
  ) {
    return;
  }
  cropActiveStroke.points.push(point);
  renderCropSelection();
}

function onCropMarkerPointerUp(event: PointerEvent): void {
  if (cropDrawingPointerId !== event.pointerId) return;
  cropDrawingPointerId = null;
  cropActiveStroke = null;
  window.removeEventListener("pointermove", onCropMarkerPointerMove);
  window.removeEventListener("pointerup", onCropMarkerPointerUp);
  window.removeEventListener("pointercancel", onCropMarkerPointerUp);
}

function pointerEventToCropPct(
  event: PointerEvent,
): { x: number; y: number } | null {
  const r = cropPreviewRect();
  if (r.w <= 0 || r.h <= 0) return null;
  const wrapRect = cropPreviewWrap.getBoundingClientRect();
  const localX = event.clientX - wrapRect.left - cropPreviewWrap.clientLeft;
  const localY = event.clientY - wrapRect.top - cropPreviewWrap.clientTop;
  const x = ((localX - r.x) / r.w) * 100;
  const y = ((localY - r.y) / r.h) * 100;
  return { x: clampPct(x), y: clampPct(y) };
}

function mapPercentForCrop(
  valuePct: number,
  start: number,
  span: number,
): number {
  return ((valuePct / 100 - start) / span) * 100;
}

function dominantSourceAxisLengthForDimensions(
  width: number,
  height: number,
): number {
  const box = editorBoxSize();
  const iw = Math.max(1, width || 1);
  const ih = Math.max(1, height || 1);
  const containScale = Math.min(box.width / iw, box.height / ih);
  const renderedW = iw * containScale;
  const renderedH = ih * containScale;
  return renderedW >= renderedH ? iw : ih;
}

function clampPlacementToImageBounds(
  xPct: number,
  yPct: number,
  radius: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const scaleBase = Math.max(width, height);
  const sizePx = ((radius * 2) / 100) * scaleBase;
  const half = sizePx / 2;
  const minInsideHalf = half - sizePx / 3;
  const minX = minInsideHalf;
  const maxX = width - minInsideHalf;
  const minY = minInsideHalf;
  const maxY = height - minInsideHalf;
  const px = (xPct / 100) * width;
  const py = (yPct / 100) * height;
  const clampedX = Math.min(Math.max(minX, px), Math.max(minX, maxX));
  const clampedY = Math.min(Math.max(minY, py), Math.max(minY, maxY));
  return {
    x: (clampedX / Math.max(1, width)) * 100,
    y: (clampedY / Math.max(1, height)) * 100,
  };
}

async function applyCropToActiveImage(): Promise<void> {
  const image = cropWorkingImage ?? getActiveImage();
  await cropImageInPlace(image, cropSelection);

  if (cropWorkingImage) {
    images[activeImageIndex] = cloneEditorImage(cropWorkingImage);
  }

  normalizePlacementOrders();
  if (selectedId) {
    const stillExists = images[activeImageIndex]!.placements.some(
      (placement) => placement.id === selectedId,
    );
    if (!stillExists) selectedId = null;
  }

  const firstPlacement = images[activeImageIndex]!.placements[0] ?? null;
  if (firstPlacement?.radius != null) {
    const mapped = clampGlobalRadius(
      mapImageRadiusToUniformRadius(firstPlacement.radius, activeImageIndex),
    );
    imageRadiusByIndex[activeImageIndex] = mapped;
    imageRadiusTouchedByIndex[activeImageIndex] = true;
    globalRadius = mapped;
    lastUsedRadius = mapped;
    cmSize.value = String(mapped);
  }

  loadActiveImage(false);
  scheduleEditorLayoutRefresh();
}

async function cropImageInPlace(
  image: EditorImage,
  selection: { left: number; top: number; right: number; bottom: number },
): Promise<void> {
  const leftN = selection.left / 100;
  const rightN = selection.right / 100;
  const topN = selection.top / 100;
  const bottomN = selection.bottom / 100;
  const spanX = rightN - leftN;
  const spanY = bottomN - topN;

  if (spanX <= 0 || spanY <= 0) return;
  if (
    selection.left === 0 &&
    selection.top === 0 &&
    selection.right === 100 &&
    selection.bottom === 100
  ) {
    return;
  }

  const source = await loadImage(image.dataUrl);
  const srcW = image.width || source.naturalWidth || source.width;
  const srcH = image.height || source.naturalHeight || source.height;
  const sx = Math.max(0, Math.min(srcW - 1, Math.round(srcW * leftN)));
  const sy = Math.max(0, Math.min(srcH - 1, Math.round(srcH * topN)));
  const sw = Math.max(1, Math.round(srcW * spanX));
  const sh = Math.max(1, Math.round(srcH * spanY));

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);

  const mime = image.mime === "image/png" ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(
    mime,
    mime === "image/jpeg" ? 0.98 : undefined,
  );

  const newImageBase = imageScaleBaseForDimensions(sw, sh);
  const oldDominantSourceAxis = dominantSourceAxisLengthForDimensions(
    srcW,
    srcH,
  );
  const newDominantSourceAxis = dominantSourceAxisLengthForDimensions(sw, sh);
  const sourceSizePreserveScale =
    oldDominantSourceAxis / Math.max(1, newDominantSourceAxis);

  const mappedPlacements = image.placements.map((placement) => {
    const mappedX = mapPercentForCrop(placement.x, leftN, spanX);
    const mappedY = mapPercentForCrop(placement.y, topN, spanY);
    const currentRadius =
      placement.radius ??
      mapUniformRadiusToImageRadius(globalRadius, activeImageIndex);
    const desiredRadius = currentRadius * sourceSizePreserveScale;
    const currentUniform = mapImageRadiusToUniformRadiusForBase(
      desiredRadius,
      newImageBase,
    );
    const boundedUniform = clampGlobalRadius(currentUniform);
    const boundedRadius = mapUniformRadiusToImageRadiusForBase(
      boundedUniform,
      newImageBase,
    );
    const clamped = clampPlacementToImageBounds(
      mappedX,
      mappedY,
      boundedRadius,
      sw,
      sh,
    );
    return {
      ...placement,
      x: clamped.x,
      y: clamped.y,
      radius: boundedRadius,
    } as BadgePlacement;
  });

  const mappedRedactions = image.redactions
    .map((stroke) => {
      const points = stroke.points.map((point) => {
        const mappedX = mapPercentForCrop(point.x, leftN, spanX);
        const mappedY = mapPercentForCrop(point.y, topN, spanY);
        return { x: clampPct(mappedX), y: clampPct(mappedY) };
      });
      if (!points.length) return null;
      return {
        points,
        widthPct: stroke.widthPct || REDACTION_STROKE_WIDTH_PCT,
      } as RedactionStroke;
    })
    .filter((stroke): stroke is RedactionStroke => !!stroke);

  image.dataUrl = dataUrl;
  image.base64 = dataUrl.split(",")[1] ?? "";
  image.mime = mime;
  image.width = sw;
  image.height = sh;
  image.placements = mappedPlacements;
  image.redactions = mappedRedactions;
}

function cloneEditorImage(image: EditorImage): EditorImage {
  return {
    dataUrl: image.dataUrl,
    base64: image.base64,
    mime: image.mime,
    width: image.width,
    height: image.height,
    placements: image.placements.map((placement) => ({ ...placement })),
    redactions: image.redactions.map((stroke) => ({
      widthPct: stroke.widthPct,
      points: stroke.points.map((point) => ({ ...point })),
    })),
  };
}

function syncActivePlacementRadiiFromSlider(applyToPlacements = true): void {
  const image = images[activeImageIndex];
  if (!image) return;
  if (!applyToPlacements) return;
  const mappedRadius = mapUniformRadiusToImageRadius(
    globalRadius,
    activeImageIndex,
  );
  for (const placement of image.placements) {
    placement.radius = mappedRadius;
  }
}

function startCreateCropFlow(): void {
  if (!images.length) return;
  createCropFlowActive = true;
  createCropFlowIndex = 0;
  activeImageIndex = 0;
  openCropModalForActiveImage();
}

function cancelCreateCropFlow(): void {
  createCropFlowActive = false;
  createCropFlowIndex = 0;
  images = [];
  activeImageIndex = 0;
  closeCropModal();
  createModal.classList.remove("open");
  detailsModal.classList.remove("open");
  screenMode.style.display = "flex";
}

function advanceCreateCropFlow(): void {
  if (!createCropFlowActive) return;
  if (createCropFlowIndex < images.length - 1) {
    createCropFlowIndex += 1;
    activeImageIndex = createCropFlowIndex;
    openCropModalForActiveImage();
    return;
  }
  createCropFlowActive = false;
  createCropFlowIndex = 0;
  activeImageIndex = 0;
  imageSlideDirection = null;
  pendingCreateSlideImageSrc = null;
  pendingCreateSlideBadges = null;
  navTransitionInFlight = false;
  queuedNavIndex = null;
  cmImg.src = "";
  closeCropModal();
  openEditor();
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
  startCreateCropFlow();

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
  lastUsedRadius = clampGlobalRadius(globalRadius);
  resetPerImageRadiusState();
  markerModeEnabled = false;
  updateMarkerToggleUI();
  document.title = "Creating Texting Theory Post";
  screenMode.style.display = "none";
  createModal.classList.add("open");
  submitOvl.style.display = "none";
  //   hintEl.textContent =
  //     mode === "annotated"
  //       ? "Tap to place a badge by every relevant message. Don't cover anything important."
  //       : "Tap to place a badge by every relevant message. Don't cover anything important.";
  if (isEditSession) {
    hintEl.style.display = "none";
  } else {
    hintEl.style.display = "";
  }
  syncSliderForActiveImage();
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
    syncSliderForActiveImage();
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

cmCrop.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!images.length || cropApplying) return;
  createCropFlowActive = false;
  openCropModalForActiveImage();
});

function beginCropHandleDrag(
  handle: "tl" | "tr" | "bl" | "br",
  event: PointerEvent,
): void {
  event.preventDefault();
  event.stopPropagation();
  activeCropHandle = handle;
  window.addEventListener("pointermove", onCropHandlePointerMove);
  window.addEventListener("pointerup", onCropHandlePointerUp, { once: true });
}

function onCropHandlePointerMove(event: PointerEvent): void {
  if (!activeCropHandle) return;
  const point = pointerEventToCropPct(event);
  if (!point) return;
  const minSize = MIN_CROP_SIZE_PCT;

  if (activeCropHandle === "tl") {
    cropSelection.left = Math.min(point.x, cropSelection.right - minSize);
    cropSelection.top = Math.min(point.y, cropSelection.bottom - minSize);
  } else if (activeCropHandle === "tr") {
    cropSelection.right = Math.max(point.x, cropSelection.left + minSize);
    cropSelection.top = Math.min(point.y, cropSelection.bottom - minSize);
  } else if (activeCropHandle === "bl") {
    cropSelection.left = Math.min(point.x, cropSelection.right - minSize);
    cropSelection.bottom = Math.max(point.y, cropSelection.top + minSize);
  } else {
    cropSelection.right = Math.max(point.x, cropSelection.left + minSize);
    cropSelection.bottom = Math.max(point.y, cropSelection.top + minSize);
  }

  cropSelection.left = clampPct(cropSelection.left);
  cropSelection.top = clampPct(cropSelection.top);
  cropSelection.right = clampPct(cropSelection.right);
  cropSelection.bottom = clampPct(cropSelection.bottom);

  renderCropSelection();
  scheduleCropAutoZoom();
}

function onCropHandlePointerUp(): void {
  activeCropHandle = null;
  window.removeEventListener("pointermove", onCropHandlePointerMove);
}

cropHandleTl.addEventListener("pointerdown", (event) => {
  beginCropHandleDrag("tl", event);
});

cropHandleTr.addEventListener("pointerdown", (event) => {
  beginCropHandleDrag("tr", event);
});

cropHandleBl.addEventListener("pointerdown", (event) => {
  beginCropHandleDrag("bl", event);
});

cropHandleBr.addEventListener("pointerdown", (event) => {
  beginCropHandleDrag("br", event);
});

cropMarkerToggle.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  cropMarkerModeEnabled = !cropMarkerModeEnabled;
  updateCropMarkerUI();
});

cropMarkerToggle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});

cropPreviewWrap.addEventListener("pointerdown", (event) => {
  if (!cropMarkerModeEnabled) return;
  const target = event.target as HTMLElement;
  if (target.closest("#crop-marker-toggle")) return;
  const point = cropEventToImagePercent(event);
  if (!point) return;

  event.preventDefault();
  event.stopPropagation();
  const stroke: RedactionStroke = {
    points: [point],
    widthPct: REDACTION_STROKE_WIDTH_PCT,
  };
  getCropTargetRedactions().push(stroke);
  cropActiveStroke = stroke;
  cropDrawingPointerId = event.pointerId;

  window.addEventListener("pointermove", onCropMarkerPointerMove);
  window.addEventListener("pointerup", onCropMarkerPointerUp);
  window.addEventListener("pointercancel", onCropMarkerPointerUp);
  renderCropSelection();
});

cropReset.addEventListener("click", (event) => {
  event.preventDefault();
  if (cropOriginalImage) {
    cropWorkingImage = cloneEditorImage(cropOriginalImage);
    cropPreview.src = cropWorkingImage.dataUrl;
  }
  resetCropSelection();
});

cropCancel.addEventListener("click", (event) => {
  event.preventDefault();
  if (createCropFlowActive) {
    cancelCreateCropFlow();
    return;
  }
  closeCropModal();
});

cropBg.addEventListener("click", () => {
  if (createCropFlowActive) {
    cancelCreateCropFlow();
    return;
  }
  closeCropModal();
});

cropApply.addEventListener("click", async (event) => {
  event.preventDefault();
  if (cropApplying || !images.length) return;
  cropApplying = true;
  try {
    submitOvl.style.display = "flex";
    submitText.textContent = "Cropping image…";
    await applyCropToActiveImage();
    submitOvl.style.display = "none";
    if (createCropFlowActive) {
      advanceCreateCropFlow();
    } else {
      closeCropModal();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to crop image.");
  } finally {
    submitOvl.style.display = "none";
    cropApplying = false;
  }
});

cmSize.addEventListener("input", () => {
  globalRadius = clampGlobalRadius(Number(cmSize.value) || globalRadius);
  lastUsedRadius = globalRadius;
  imageRadiusByIndex[activeImageIndex] = globalRadius;
  imageRadiusTouchedByIndex[activeImageIndex] = true;
  syncActivePlacementRadiiFromSlider(true);
  if (sliderVisualFrame) {
    return;
  }
  sliderVisualFrame = requestAnimationFrame(() => {
    sliderVisualFrame = 0;
    render();
  });
});

function commitSliderVisualUpdate(): void {
  if (sliderVisualFrame) {
    cancelAnimationFrame(sliderVisualFrame);
    sliderVisualFrame = 0;
  }
  syncActivePlacementRadiiFromSlider(true);
  render();
}

cmSize.addEventListener("change", commitSliderVisualUpdate);
cmSize.addEventListener("pointerup", commitSliderVisualUpdate);
cmSize.addEventListener("touchend", commitSliderVisualUpdate, {
  passive: true,
});

cmImg.addEventListener("load", () => {
  scheduleEditorLayoutRefresh();
});

cropPreview.addEventListener("load", () => {
  renderCropSelection();
});

function openDetailsForPosting(): void {
  sideRow.style.display = "flex";
  otherRow.style.display =
    mode === "vote" && eloSide === "other" ? "flex" : "none";
  detailsModal.classList.add("open");
  updateSideUI();
}

cmNext.addEventListener("click", () => {
  if (cmNext.disabled) return;
  if (isEditSession) {
    void submitEditSession();
    return;
  }
  const hasMissingImageBadges =
    images.length > 1 && images.some((img) => img.placements.length === 0);
  if (hasMissingImageBadges) {
    missingImageModal.classList.add("open");
    return;
  }
  if (getTotalPlacements() === 1) {
    singleBadgeModal.classList.add("open");
    return;
  }
  openDetailsForPosting();
});

singleBadgeBg.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
});

singleBadgeCancel.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
});

singleBadgeContinue.addEventListener("click", () => {
  singleBadgeModal.classList.remove("open");
  openDetailsForPosting();
});

missingImageBg.addEventListener("click", () => {
  missingImageModal.classList.remove("open");
});

missingImageCancel.addEventListener("click", () => {
  missingImageModal.classList.remove("open");
});

missingImageContinue.addEventListener("click", () => {
  missingImageModal.classList.remove("open");
  openDetailsForPosting();
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
  pickerTitle.textContent = "Choose Classification (Best → Worst)";
  pickerBody.innerHTML = "";
  suppressEditorPickerUntil = Date.now() + 900;
  suppressEditorPickerBackdropUntil =
    Date.now() + EDITOR_PICKER_BACKDROP_GUARD_MS;

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
  if (Date.now() < suppressEditorPickerBackdropUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  suppressEditorPickerUntil = Date.now() + 450;
  closePicker();
});
pickerBg.addEventListener("click", (event) => {
  if (Date.now() < suppressEditorPickerBackdropUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  suppressEditorPickerUntil = Date.now() + 450;
  closePicker();
});

document.addEventListener("pointerdown", (event) => {
  if (!pickerModal.classList.contains("open")) return;
  const target = event.target as HTMLElement;
  if (target.closest(".picker-sheet") || target.closest(".ed-badge")) {
    return;
  }
  closePicker();
});
window.addEventListener("resize", () => {
  scheduleEditorLayoutRefresh();
  if (cropModal.classList.contains("open")) {
    renderCropSelection();
  }
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
