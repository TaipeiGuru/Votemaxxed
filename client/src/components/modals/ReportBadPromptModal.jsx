import { useEffect } from "react";

export function ReportBadPromptModal({ onClose, onConfirm }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="report-bad-prompt-modal" role="presentation" onClick={onClose}>
      <div className="report-bad-prompt-modal-backdrop" aria-hidden />
      <div
        className="report-bad-prompt-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-bad-prompt-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="report-bad-prompt-heading" className="report-bad-prompt-modal-title">
          Report bad prompt
        </h3>
        <p className="report-bad-prompt-modal-body">
          Are you sure you want to report this as a low tier normie prompt?
        </p>
        <div className="report-bad-prompt-modal-actions">
          <button
            type="button"
            className="report-bad-prompt-modal-btn report-bad-prompt-modal-btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="report-bad-prompt-modal-btn report-bad-prompt-modal-btn--primary"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
