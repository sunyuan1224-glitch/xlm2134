/*
 * 导出报告弹窗：当导出有降级（复杂块保留源码、远程图占位）或图片读取失败时弹出，
 * 逐条列出细节，并明确指出写出的文件路径（没有伪成功）。
 */
import { useEffect, useRef, type JSX } from "react";
import type { ExportReport } from "../lib/exportActions";
import { ModalStage } from "./ModalStage";

interface Props {
  title: string;
  report: ExportReport;
  onClose: () => void;
}

export function ExportReportDialog({ title, report, onClose }: Props): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <ModalStage>
      <div className="modal" style={{ width: "min(620px, calc(100vw - 32px))" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div style={{ maxHeight: "60vh", overflowY: "auto", fontSize: "13px", lineHeight: "1.6", color: "var(--fg)" }}>
          <p style={{ margin: "0 0 10px", fontWeight: "bold" }}>{report.summary}</p>
          {report.lines.length > 0 && (
            <div
              style={{
                background: "var(--bg-dim, #181825)",
                border: "1px solid var(--border, #313244)",
                borderRadius: "6px",
                padding: "8px 12px",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "12px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {report.lines.join("\n")}
            </div>
          )}
        </div>
        <div className="modal-actions" style={{ marginTop: "14px" }}>
          <button ref={closeRef} className="btn accent" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}

export default ExportReportDialog;
