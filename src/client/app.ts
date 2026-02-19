import { navigateTo } from "@devvit/client";
import {
  ApiEndpoint,
  Classification,
  PICKER_CLASSIFICATIONS,
  BADGE_INFO,
  BADGE_HINTS,
  MAX_VOTE_POST_IMAGES,
  MAX_ANNOTATED_POST_IMAGES,
  type CreatePostRequest,
  type CreatePostResponse,
  type BadgePlacement,
  type PostMode,
  type EloSide,
} from "../shared/api.ts";

type EditorImage = {
  dataUrl: string;
  base64: string;
  mime: string;
  width: number;
  height: number;
  placements: BadgePlacement[];
};

const MAX_IMAGE_DIM = 2048;
const VOTE_MIN_RADIUS = 4;
const ANNOTATED_MIN_RADIUS = 2;
const ANNOTATED_EXPORT_MIN_LONG_SIDE = 1280;

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

const $ = (id: string) => document.getElementById(id)!;

const screenMode = $("screen-mode") as HTMLDivElement;
const btnVote = $("btn-vote");
const btnAnn = $("btn-annotate");
const fileInput = $("file-input") as HTMLInputElement;

const createModal = $("create-modal") as HTMLDivElement;
const cmTitle = $("cm-title") as HTMLInputElement;
const cmImg = $("cm-img") as HTMLImageElement;
const cmCanvasWrap = $("cm-canvas-wrap") as HTMLDivElement;
const cmBadges = $("cm-badges") as HTMLDivElement;
const hintEl = $("hint") as HTMLDivElement;
const cmPageChip = $("cm-page-chip") as HTMLDivElement;
const cmImageNav = $("cm-image-nav") as HTMLDivElement;
const cmImgPrev = $("cm-img-prev") as HTMLButtonElement;
const cmImgNext = $("cm-img-next") as HTMLButtonElement;
const cmImgDots = $("cm-img-dots") as HTMLDivElement;

const cmSize = $("cm-size") as HTMLInputElement;
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

const OTHER_ELO_LABEL_REGEX = /^[A-Za-z]{1,20}$/;

function sanitizeOtherEloLabel(value: string): string {
  return value.replace(/[^A-Za-z]/g, "").slice(0, 20);
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

function applySliderBoundsForMode(): void {
  const min = sliderMinForMode();
  cmSize.min = String(min);
  const current = Number(cmSize.value) || globalRadius;
  if (current < min) {
    cmSize.value = String(min);
  }
  globalRadius = Number(cmSize.value) || min;
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

function openEditor() {
  applySliderBoundsForMode();
  globalRadius = Number(cmSize.value) || globalRadius;
  document.title = "Creating Texting Theory Post";
  screenMode.style.display = "none";
  createModal.classList.add("open");
  hintEl.textContent =
    mode === "annotated"
      ? "Tap to place a badge."
      : "Tap to place a badge next to every single message.";
  syncPlacementRadiiFromSlider();
  updateSideUI();
  loadActiveImage();
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
  cmImgPrev.style.display = activeImageIndex > 0 ? "inline-flex" : "none";
  cmImgNext.style.display =
    activeImageIndex < images.length - 1 ? "inline-flex" : "none";
}

cmImageNav.addEventListener("pointerdown", (event) => event.stopPropagation());
cmImageNav.addEventListener("click", (event) => event.stopPropagation());

function updateNextEnabled() {
  const hasAnyPlacements = images.some((img) => img.placements.length > 0);
  cmNext.disabled = !hasAnyPlacements;
}

cmImgPrev.addEventListener("click", () => {
  if (activeImageIndex <= 0) return;
  activeImageIndex -= 1;
  selectedId = null;
  loadActiveImage();
});

cmImgNext.addEventListener("click", () => {
  if (activeImageIndex >= images.length - 1) return;
  activeImageIndex += 1;
  selectedId = null;
  loadActiveImage();
});

function loadActiveImage() {
  const image = getActiveImage();
  cmImg.onload = () => {
    render();
    requestAnimationFrame(() => {
      render();
    });
  };
  cmImg.src = image.dataUrl;
  if (cmImg.complete) {
    cmImg.onload?.(new Event("load"));
  }
  updateImageNav();
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
        selectedId = null;
        render();
      });
      el.appendChild(del);
    }

    el.addEventListener("pointerdown", (event) =>
      onBadgePointerDown(event, placement),
    );
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      const wasSelected = selectedId === placement.id;
      selectBadge(placement.id);
      if (mode === "annotated") {
        if (wasSelected) {
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
    selectedId = id;
    hintEl.classList.add("hidden");
    render();
  }
});

function onBadgePointerDown(event: PointerEvent, placement: BadgePlacement) {
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

cmSize.addEventListener("input", () => {
  globalRadius = Number(cmSize.value);
  syncPlacementRadiiFromSlider();
  render();
});

cmNext.addEventListener("click", () => {
  if (cmNext.disabled) return;
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

cmPost.addEventListener("click", async () => {
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
      const txt = sanitizeOtherEloLabel(otherInput.value.trim());
      otherInput.value = txt;
      if (!txt) {
        alert("Enter who this Elo vote should target (letters only).");
        otherInput.focus();
        return;
      }
      if (!OTHER_ELO_LABEL_REGEX.test(txt)) {
        alert("Other target must be letters only, max 20 characters.");
        otherInput.focus();
        return;
      }
      eloOtherText = txt;
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
        : images.map((img) => ({
            imageData: img.base64,
            imageMimeType: img.mime,
            imageWidth: img.width,
            imageHeight: img.height,
            placements: img.placements,
          }));

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
        submitText.textContent = "Post created successfully";
        await new Promise((resolve) => setTimeout(resolve, 650));
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
      submitText.textContent = "Post created successfully";
      await new Promise((resolve) => setTimeout(resolve, 650));
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

pickerBg.addEventListener("click", closePicker);
window.addEventListener("resize", () => {
  syncPlacementRadiiFromSlider();
  render();
});

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

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
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
