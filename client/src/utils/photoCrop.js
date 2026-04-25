/** Preview size (px); must match `.photo-crop-viewport` width/height in CSS. */
export const PHOTO_CROP_PREVIEW_PX = 320;
/** Output square size (JPEG) — matches 1:1 grid display. */
export const PHOTO_CROP_EXPORT_PX = 800;

/** Pan clamp for contain-fit baseline: full image visible at zoom 1; pan only when zoomed past the edges. */
export function clampPhotoPan(pan, zoom, iw, ih, V) {
  if (!iw || !ih || !V) return { x: 0, y: 0 };
  const fitScale = Math.min(V / iw, V / ih);
  const w = iw * fitScale * zoom;
  const h = ih * fitScale * zoom;
  const maxPX = Math.max(0, (w - V) / 2);
  const maxPY = Math.max(0, (h - V) / 2);
  return {
    x: Math.max(-maxPX, Math.min(maxPX, pan.x)),
    y: Math.max(-maxPY, Math.min(maxPY, pan.y)),
  };
}

/** Match on-screen viewport: contain-scale × zoom, centered with pan; letterbox areas use bg. */
export function exportPhotoSquareCrop(img, zoom, pan, previewPx, outputPx) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return "";
  const V = previewPx;
  const S = outputPx;
  const fitScale = Math.min(V / iw, V / ih);
  const s = fitScale * zoom;
  const scaleDest = S / V;
  const destCx = S / 2 + pan.x * scaleDest;
  const destCy = S / 2 + pan.y * scaleDest;
  const drawW = iw * s * scaleDest;
  const drawH = ih * s * scaleDest;

  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0f1114";
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img, 0, 0, iw, ih, destCx - drawW / 2, destCy - drawH / 2, drawW, drawH);
  return canvas.toDataURL("image/jpeg", 0.88);
}
