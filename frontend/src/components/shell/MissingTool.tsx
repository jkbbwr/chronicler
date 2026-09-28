import { type Component } from "solid-js";
import { Button } from "../ui";
import { INSTALL, recheckTools } from "../../stores/tools";
import "./MissingTool.css";

/** "X needs <tool>" with how to install it and a re-check. */
export const MissingTool: Component<{ tool: keyof typeof INSTALL }> = (props) => {
  const t = () => INSTALL[props.tool];
  const linux = navigator.platform.toLowerCase().includes("linux");
  return (
    <div class="missing-tool">
      <strong>{t().what} needs {t().name}, which isn't installed.</strong>
      <span>
        {linux ? "Install it with your package manager, or see " : <>Install it with <code>{t().brew}</code>, or see </>}
        <a href={t().url} target="_blank" rel="noreferrer">the install guide</a>, then:
      </span>
      <Button size="sm" onClick={() => void recheckTools()}>Check again</Button>
    </div>
  );
};
