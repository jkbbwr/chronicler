import { type Component } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { workbench } from "../../stores/workbench";

interface MarkdownPreviewProps {
  content: string;
}

export const MarkdownPreview: Component<MarkdownPreviewProps> = (props) => {
  const html = () => DOMPurify.sanitize(marked.parse(props.content, { async: false }) as string);

  return (
    <div style={{ height: "100%", "overflow-y": "auto" }}>
      <div
        class="markdown-preview"
        style={{
          "font-family": workbench.settings.fontFamily,
          "font-size": `${workbench.settings.fontSize}px`,
        }}
        innerHTML={html()}
      />
    </div>
  );
};
