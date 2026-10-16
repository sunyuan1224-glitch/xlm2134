import { useEffect, useRef } from "react";
import companionUrl from "../assets/paper-companion.png";
import { placeCompanion, type CompanionLayout } from "../lib/paperCompanion";
import { useStore } from "../store";

const FALLBACK_ASPECT = 328 / 1122;

/**
 * 打字时站在稿纸**左侧**的人物（原素材朝左，CSS 里镜像成面朝正文）。指针事件全部
 * 穿透，不挡输入、选区和右键。
 * 父元素须是 position: relative 的编辑区（.editor-area 或沉浸模式的 .im-stage）。
 *
 * 因为父元素就是编辑区，而编辑区排在左侧栏之后，所以侧栏收起 / 拖宽时这块立绘
 * 自动跟着挪，不需要任何监听。
 */
export function PaperCompanion() {
  const visible = useStore((s) => s.companionVisible);
  const imgRef = useRef<HTMLImageElement>(null);
  const aspectRef = useRef(FALLBACK_ASPECT);

  useEffect(() => {
    if (!visible) return;
    const img = imgRef.current;
    const host = img?.parentElement;
    if (!img || !host) return;

    const apply = (next: CompanionLayout | null) => {
      if (!next) {
        img.style.opacity = "0";
        img.style.width = "0px";
        img.style.height = "0px";
        return;
      }
      img.style.opacity = "";
      img.style.left = `${next.left}px`;
      img.style.width = `${next.width}px`;
      img.style.height = `${next.height}px`;
    };

    const measure = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        aspectRef.current = img.naturalWidth / img.naturalHeight;
      }
      const scroller = host.querySelector(".cm-scroller");
      let padLeft = 16;
      let padRight = 16;
      if (scroller) {
        const s = getComputedStyle(scroller);
        padLeft = parseFloat(s.paddingLeft) || 0;
        padRight = parseFloat(s.paddingRight) || 0;
      }
      const raw = getComputedStyle(host).getPropertyValue("--editor-measure").trim();
      const measurePx = raw.endsWith("px") ? parseFloat(raw) : cssLengthToPx(host, raw || "752px");
      apply(
        placeCompanion({
          width: host.clientWidth,
          height: host.clientHeight,
          measure: measurePx || 752,
          padLeft,
          padRight,
          aspect: aspectRef.current,
        }),
      );
    };

    // 直接改样式，不经 React 再等一帧，避免边栏展开时人先停在旧位置再弹回去。
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    img.addEventListener("load", measure);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", measure);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <img
      ref={imgRef}
      className="paper-companion"
      src={companionUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** 把 42em 这类长度解析成像素。当前主题把栏宽写成 px，这里只是兜底。 */
function cssLengthToPx(host: Element, raw: string): number {
  const probe = document.createElement("div");
  probe.style.width = raw;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  host.appendChild(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}
