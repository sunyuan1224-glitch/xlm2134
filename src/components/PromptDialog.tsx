/*
 * 通用小对话框：一个标题 + 若干输入框 + 确定/取消。
 * 链接地址、图片说明、新建文件等都走这里，避免为每种输入各写一个弹窗。
 */
import { useEffect, useRef, useState } from "react";
import { ModalStage } from "./ModalStage";

export interface PromptField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: "text" | "number";
  min?: number;
  max?: number;
}

interface Props {
  title: string;
  fields: PromptField[];
  confirmLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}

export function PromptDialog({ title, fields, confirmLabel = "确定", onSubmit, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = f.value ?? "";
    return init;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  const submit = () => {
    onSubmit(values);
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <ModalStage>
      <div className="modal prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="prompt-fields">
          {fields.map((f, i) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              <input
                ref={i === 0 ? firstRef : undefined}
                className="panel-input"
                type={f.type === "number" ? "number" : "text"}
                min={f.min}
                max={f.max}
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") onClose();
                }}
              />
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn accent" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
      </ModalStage>
    </div>
  );
}

export default PromptDialog;
