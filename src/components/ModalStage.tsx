import thinkerUrl from "../assets/widget-girl.png";

/**
 * 居中选框的「思考」外壳：气泡在上，角色在右下角，像是想完才弹出这张框。
 * 角色和圆点不接点击，免得挡住确定 / 取消。
 *
 * 角色图与右下角的小鸭挂件是同一张（原来是另一张 dialog-thinker.png，已弃用），
 * 这样「弹窗里那个小人」和「挂件」是同一个形象，不会像两个角色。
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
