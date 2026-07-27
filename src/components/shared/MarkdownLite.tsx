// 极简 Markdown 渲染：处理 # / ## 标题、- / * 列表、空行段落。
// 从 TextTranslate 与 Summary 中抽取，避免重复定义。

export default function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const t = line.trim();
        if (t.startsWith("## ")) return <h2 key={i}>{t.slice(3)}</h2>;
        if (t.startsWith("# ")) return <h2 key={i}>{t.slice(2)}</h2>;
        if (t.startsWith("- ") || t.startsWith("* ")) {
          return (
            <p key={i} className="pl-3">
              • {t.slice(2)}
            </p>
          );
        }
        if (!t) return <div key={i} className="h-2" />;
        return <p key={i}>{line}</p>;
      })}
    </>
  );
}
