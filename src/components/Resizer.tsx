interface Props {
  /** col = 左右拖动调宽度，row = 上下拖动调高度 */
  direction: "col" | "row";
  onMove: (delta: number) => void;
}

/** 可拖拽分隔条：按住拖动，回调增量像素 */
export default function Resizer({ direction, onMove }: Props) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let last = direction === "col" ? e.clientX : e.clientY;
    const move = (ev: MouseEvent) => {
      const cur = direction === "col" ? ev.clientX : ev.clientY;
      if (cur !== last) {
        onMove(cur - last);
        last = cur;
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.userSelect = "none";
    document.body.style.cursor = direction === "col" ? "col-resize" : "row-resize";
  };

  return <div className={`resizer ${direction}`} onMouseDown={onMouseDown} />;
}
