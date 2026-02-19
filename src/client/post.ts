import { requestExpandedMode, showToast } from "@devvit/client";
import {
  ApiEndpoint,
  BADGE_INFO,
  BADGE_HINTS,
  Classification,
  PICKER_CLASSIFICATIONS,
  ELO_COLOR_STOPS,
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
let viewerUserId = "";
let refreshTimer: number | null = null;
let imageLoadToken = 0;
let lastBadgeLayoutKey = "";
let lastUserInteractionAt = 0;
let suppressCanvasExpandUntil = 0;

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
const eloEl = $("elo") as HTMLDivElement;
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
  return -((nowMs % 6000) / 1000);
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
  return !!postData && postData.creatorId === viewerUserId;
}

function isVotingWindowOpen(): boolean {
  const createdAtMs = postData?.createdAtMs;
  if (!createdAtMs) return true;
  return Date.now() - createdAtMs <= MAX_POST_AGE_TO_VOTE_MS;
}

function canVoteOnCurrentPost(): boolean {
  return !!postData && postData.mode === "vote" && !isOwnPost() && isVotingWindowOpen();
}

function getCanvasRect() {
  const canvasRect = canvasEl.getBoundingClientRect();
  const boxW = canvasRect.width;
  const boxH = canvasRect.height;
  const naturalW = canvasImg.naturalWidth || canvasImg.width || 0;
  const naturalH = canvasImg.naturalHeight || canvasImg.height || 0;

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

function eloGradientCSS(): string {
  const stops = ELO_COLOR_STOPS.map((s) => {
    const pct = ((s.elo - MIN_ELO) / (MAX_ELO - MIN_ELO)) * 100;
    return `${s.hex} ${pct.toFixed(1)}%`;
  }).join(", ");
  return `linear-gradient(to right, ${stops})`;
}

async function init() {
  try {
    const res = await fetch(ApiEndpoint.Init);
    const data = (await res.json()) as InitResponse;

    postData = data.postData ? normalizePostData(data.postData) : null;
    consensus = data.consensus;
    userVotes = data.userVotes;
    userElo = data.userElo;
    lastSubmittedElo = userElo;
    viewerUserId = data.userId;

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
    quickCreateBtn.addEventListener("click", (event) => {
      try {
        requestExpandedMode(event as unknown as MouseEvent, "create");
      } catch {
        window.location.href = "/app.html";
      }
    });
    if (postData.images.length > 1) imageNav.style.display = "flex";
    updateImageNav();
    loadCurrentImage();

    if (canVoteOnCurrentPost()) {
      eloEl.style.display = "";
      setupElo();
    }

    if (refreshTimer === null) {
      refreshTimer = window.setInterval(() => {
        void refreshPostState();
      }, 6000);
      window.addEventListener("beforeunload", () => {
        if (refreshTimer !== null) {
          window.clearInterval(refreshTimer);
          refreshTimer = null;
        }
      });
    }
  } catch (err) {
    console.error("Init failed:", err);
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

    if (canVoteOnCurrentPost()) {
      eloEl.style.display = "";
      updateEloDisplay();
    } else {
      eloEl.style.display = "none";
    }

    updateImageNav();
    const nextImageUrl = currentImage()?.imageUrl ?? null;
    if (nextImageUrl && nextImageUrl !== currentImageUrl) {
      loadCurrentImage();
    } else {
      layoutBadges();
    }
  } catch {
    // best-effort refresh
  }
}

function loadCurrentImage() {
  const image = currentImage();
  if (!image) return;
  lastBadgeLayoutKey = "";
  badgesEl.innerHTML = "";
  const token = ++imageLoadToken;
  canvasImg.onload = () => {
    if (token !== imageLoadToken) return;
    layoutBadges(true);
    requestAnimationFrame(() => {
      if (token !== imageLoadToken) return;
      layoutBadges(true);
    });
  };
  canvasImg.src = image.imageUrl;
}

function updateImageNav() {
  if (!postData) return;
  const hasMultiple = postData.images.length > 1;
  pageChip.style.display = hasMultiple ? "block" : "none";
  pageChip.textContent = `${activeImageIndex + 1}/${postData.images.length}`;
  imgDots.innerHTML = "";
  for (let index = 0; index < postData.images.length; index++) {
    const dot = document.createElement("div");
    dot.className = "img-dot";
    if (index === activeImageIndex) dot.classList.add("active");
    imgDots.appendChild(dot);
  }
  imgPrev.style.display = activeImageIndex > 0 ? "inline-flex" : "none";
  imgNext.style.display =
    activeImageIndex < postData.images.length - 1 ? "inline-flex" : "none";
}

imgPrev.addEventListener("click", () => {
  if (!postData || activeImageIndex <= 0) return;
  activeImageIndex -= 1;
  updateImageNav();
  loadCurrentImage();
});

imgNext.addEventListener("click", () => {
  if (!postData || activeImageIndex >= postData.images.length - 1) return;
  activeImageIndex += 1;
  updateImageNav();
  loadCurrentImage();
});

canvasEl.addEventListener("click", (event) => {
  if (Date.now() < suppressCanvasExpandUntil) {
    return;
  }
  const target = event.target as HTMLElement;
  if (
    target.closest(".badge") ||
    target.closest(".img-nav-btn") ||
    target.closest("#quick-create") ||
    target.closest(".image-nav")
  ) {
    return;
  }
  try {
    requestExpandedMode(event as unknown as MouseEvent, "default");
  } catch {
    // no-op fallback
  }
});

function layoutBadges(force = false) {
  if (!postData) return;
  const pd = postData;
  const image = currentImage();
  if (!image) return;

  const nextLayoutKey = buildBadgeLayoutKey(image);
  if (!force && nextLayoutKey === lastBadgeLayoutKey) return;
  lastBadgeLayoutKey = nextLayoutKey;

  const r = getCanvasRect();
  const scaleBase = markerScaleBase(r);

  badgesEl.style.left = `${r.x}px`;
  badgesEl.style.top = `${r.y}px`;
  badgesEl.style.width = `${r.w}px`;
  badgesEl.style.height = `${r.h}px`;
  badgesEl.innerHTML = "";

  image.placements.forEach((p) => {
    const rad = p.radius || 3.5;
    const sizePx = ((rad * 2) / 100) * scaleBase;

    const el = document.createElement("div");
    el.className = "badge";
    el.style.width = `${sizePx}px`;
    el.style.height = `${sizePx}px`;
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;

    const c = consensus[p.id];
    const uv = userVotes[p.id];
    const hasConsensus =
      c && c.totalVotes >= MIN_VOTES_FOR_BADGE_CONSENSUS && c.classification;

    if (pd.mode === "annotated" && p.classification) {
      el.classList.add("badge--voted");
      el.style.backgroundImage = `url(${badgeAsset(p.classification)})`;
    } else {
      if (hasConsensus) {
        el.classList.add("badge--voted");
        el.style.backgroundImage = `url(${badgeAsset(c!.classification!)})`;
      } else {
        el.classList.add("badge--placeholder");
        el.style.backgroundImage = `url(${unknownBadgeAsset()})`;
      }

      if (pd.mode === "vote") {
        if (!uv && canVoteOnCurrentPost()) {
          el.classList.add("badge--ring");
          el.classList.add("badge--tappable");
          el.style.setProperty("--ring-delay", `${ringPhaseDelaySeconds()}s`);
          el.style.setProperty(
            "--ring-width",
            `${Math.max(1.25, sizePx * 0.085)}px`,
          );
        }

        if (uv && !isOwnPost()) {
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

    if (pd.mode === "vote" && canVoteOnCurrentPost()) {
      el.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        markUserInteraction();
        openPicker(p);
      });
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    badgesEl.appendChild(el);
  });
}

window.addEventListener("resize", () => layoutBadges(true));

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
  const currentVote = userVotes[p.id];

  pickerTitle.textContent = "Vote for Classification";
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
  markUserInteraction();
  closeHint();
}

pickerBg.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  suppressCanvasExpandUntil = Date.now() + 450;
  closePicker();
});
pickerBg.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  suppressCanvasExpandUntil = Date.now() + 450;
  closePicker();
});

async function voteBadge(p: BadgePlacement, cls: Classification) {
  if (postData && postData.creatorId === viewerUserId) {
    return;
  }

  const previousVote = userVotes[p.id];
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
  eloSlider.style.background = eloGradientCSS();

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
  const thumbSize = 24;
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

eloSlider.addEventListener("input", updateEloDisplay);
window.addEventListener("resize", updateGmTickPosition);

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
