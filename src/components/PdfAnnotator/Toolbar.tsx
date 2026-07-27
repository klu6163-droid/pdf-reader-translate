// 顶部工具栏：工具切换 / 颜色 / 缩放 / 列表开关 / 保存 / 关闭
import {
  Highlighter, Loader2, Minus, MousePointer2, Pen, Plus, Save,
  Square, StickyNote, Strikethrough, Underline, X, List,
} from "lucide-react";
import ToolBtn from "../shared/ToolBtn";
import { PALETTE, type Tool } from "./constants";

interface Props {
  name: string;
  tool: Tool;
  color: string;
  scale: number;
  sidebarOpen: boolean;
  saving: boolean;
  disabled: boolean;
  onPickTool: (t: Tool) => void;
  onColor: (c: string) => void;
  onZoom: (delta: number) => void;
  onToggleSidebar: () => void;
  onSave: () => void;
  onClose: () => void;
}

export default function AnnotToolbar({
  name,
  tool,
  color,
  scale,
  sidebarOpen,
  saving,
  disabled,
  onPickTool,
  onColor,
  onZoom,
  onToggleSidebar,
  onSave,
  onClose,
}: Props) {
  return (
    <header className="flex items-center gap-2 px-3 h-12 bg-white shrink-0 shadow">
      <Highlighter size={18} className="text-primary-600 shrink-0" />
      <span className="font-semibold text-slate-800 shrink-0">PDF 批注</span>
      <span className="text-xs text-slate-400 truncate max-w-[160px]">{name}</span>

      {/* 工具 */}
      <div className="flex items-center gap-0.5 ml-2 pl-2 border-l">
        <ToolBtn variant="annotator" icon={<MousePointer2 size={15} />} label="选择"
          active={tool === "select"} onClick={() => onPickTool("select")} />
        <ToolBtn variant="annotator" icon={<Highlighter size={15} />} label="高亮"
          active={tool === "highlight"} onClick={() => onPickTool("highlight")} />
        <ToolBtn variant="annotator" icon={<Underline size={15} />} label="下划线"
          active={tool === "underline"} onClick={() => onPickTool("underline")} />
        <ToolBtn variant="annotator" icon={<Strikethrough size={15} />} label="删除线"
          active={tool === "strikeout"} onClick={() => onPickTool("strikeout")} />
        <ToolBtn variant="annotator" icon={<StickyNote size={15} />} label="笔记"
          active={tool === "note"} onClick={() => onPickTool("note")} />
        <ToolBtn variant="annotator" icon={<Square size={15} />} label="矩形"
          active={tool === "rectangle"} onClick={() => onPickTool("rectangle")} />
        <ToolBtn variant="annotator" icon={<Pen size={15} />} label="画笔"
          active={tool === "ink"} onClick={() => onPickTool("ink")} />
      </div>

      {/* 颜色 */}
      <div className="flex items-center gap-1 ml-1 pl-2 border-l">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onColor(c)}
            className={`w-4.5 h-4.5 w-[18px] h-[18px] rounded-full border ${
              color === c ? "ring-2 ring-offset-1 ring-slate-500" : "border-slate-300"
            }`}
            style={{ background: c }}
            title={c}
          />
        ))}
        <label
          className="w-[18px] h-[18px] rounded-full border border-slate-300 overflow-hidden cursor-pointer relative"
          title="自定义颜色"
        >
          <span
            className="absolute inset-0"
            style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
          />
          <input
            type="color"
            value={color}
            onChange={(e) => onColor(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
      </div>

      {/* 缩放 */}
      <div className="flex items-center gap-0.5 ml-1 pl-2 border-l">
        <button
          onClick={() => onZoom(-0.15)}
          className="p-1 hover:bg-slate-100 rounded"
          title="缩小"
        >
          <Minus size={14} />
        </button>
        <span className="w-10 text-center text-xs">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => onZoom(0.15)}
          className="p-1 hover:bg-slate-100 rounded"
          title="放大"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        <button
          onClick={onToggleSidebar}
          className={`p-1.5 rounded ${
            sidebarOpen ? "bg-primary-50 text-primary-700" : "hover:bg-slate-100 text-slate-600"
          }`}
          title="批注列表"
        >
          <List size={16} />
        </button>
        <button
          onClick={onSave}
          disabled={saving || disabled}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          保存为批注 PDF
        </button>
        <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded" title="关闭">
          <X size={18} />
        </button>
      </div>
    </header>
  );
}
