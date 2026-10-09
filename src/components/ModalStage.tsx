import thinkerUrl from "../assets/dialog-thinker.png";

/**
 * 居中选框的「思考」外壳：气泡在上，角色在右下角，像是想完才弹出这张框。
 * 角色和圆点不接点击，免得挡住确定 / 取消。
 */
export function ModalStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="modal-stage">
      {children}
      <span className="modal-think-dots" aria-hidden="true" />
      <img className="modal-thinker" src={thinkerUrl} alt="" draggable={false} />
    </div>
  );
}
