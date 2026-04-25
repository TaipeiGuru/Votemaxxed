import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampPhotoPan,
  exportPhotoSquareCrop,
  PHOTO_CROP_EXPORT_PX,
  PHOTO_CROP_PREVIEW_PX,
} from "../../utils/photoCrop.js";

export function PhotoSquareCropModal({ imageSrc, onCancel, onConfirm, submitting = false }) {
  const imgRef = useRef(null);
  const viewportRef = useRef(null);
  const [viewportPx, setViewportPx] = useState(PHOTO_CROP_PREVIEW_PX);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  const maxZoom = useMemo(() => {
    if (!natural.w || !natural.h) return 3;
    const aspect = Math.max(natural.w / natural.h, natural.h / natural.w);
    return Math.min(15, Math.max(3, aspect * 1.02));
  }, [natural]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural({ w: 0, h: 0 });
  }, [imageSrc]);

  useEffect(() => {
    setZoom((z) => Math.min(z, maxZoom));
  }, [maxZoom]);

  const { baseW, baseH } = useMemo(() => {
    if (!natural.w || !natural.h || !viewportPx) return { baseW: 0, baseH: 0 };
    const fs = Math.min(viewportPx / natural.w, viewportPx / natural.h);
    return { baseW: natural.w * fs, baseH: natural.h * fs };
  }, [natural, viewportPx]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setViewportPx(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageSrc]);

  const applyClamp = useCallback(
    (p, z) => {
      const img = imgRef.current;
      if (!img?.naturalWidth) return p;
      const V = viewportPx > 0 ? viewportPx : PHOTO_CROP_PREVIEW_PX;
      return clampPhotoPan(p, z, img.naturalWidth, img.naturalHeight, V);
    },
    [viewportPx]
  );

  useEffect(() => {
    setPan((p) => applyClamp(p, zoom));
  }, [zoom, applyClamp]);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (img?.naturalWidth) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
    setPan((p) => applyClamp(p, zoom));
  }, [applyClamp, zoom]);

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ox: e.clientX - pan.x, oy: e.clientY - pan.y };
  };

  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const next = {
      x: e.clientX - dragRef.current.ox,
      y: e.clientY - dragRef.current.oy,
    };
    setPan(applyClamp(next, zoom));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const handleConfirm = () => {
    if (submitting) return;
    const img = imgRef.current;
    if (!img?.naturalWidth || baseW <= 0) return;
    const p = applyClamp(pan, zoom);
    const V = viewportPx > 0 ? viewportPx : PHOTO_CROP_PREVIEW_PX;
    onConfirm(exportPhotoSquareCrop(img, zoom, p, V, PHOTO_CROP_EXPORT_PX));
  };

  return (
    <div
      className="photo-crop-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-crop-title"
      onClick={submitting ? undefined : onCancel}
    >
      <div className="photo-crop-modal-backdrop" aria-hidden />
      <div className="photo-crop-modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="photo-crop-title" className="photo-crop-modal-title">
          Zoom and crop
        </h3>
        <p className="muted photo-crop-modal-hint">
          Drag your finger to reposition and use the slider to zoom. Tap outside this card to
          pick a different image.
        </p>
        <div
          ref={viewportRef}
          className="photo-crop-viewport"
          onPointerDown={baseW > 0 ? onPointerDown : undefined}
          onPointerMove={baseW > 0 ? onPointerMove : undefined}
          onPointerUp={baseW > 0 ? endDrag : undefined}
          onPointerCancel={baseW > 0 ? endDrag : undefined}
        >
          <div
            className={`photo-crop-pan-layer${baseW > 0 ? "" : " photo-crop-pan-layer--loading"}`}
            style={
              baseW > 0
                ? {
                    width: `${baseW}px`,
                    height: `${baseH}px`,
                    transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
                  }
                : undefined
            }
          >
            <img
              ref={imgRef}
              src={imageSrc}
              alt=""
              draggable={false}
              className="photo-crop-img"
              onLoad={onImgLoad}
            />
          </div>
        </div>
        <label className="photo-crop-zoom-label">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={maxZoom}
            step={0.02}
            value={Math.min(zoom, maxZoom)}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        <div className="photo-crop-actions photo-crop-actions--single">
          <button
            type="button"
            onClick={handleConfirm}
            className="photo-crop-primary"
            disabled={baseW <= 0 || submitting}
          >
            {submitting ? "Submitting…" : "Submit Photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
