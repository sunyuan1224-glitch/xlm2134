"""Run the browser fixture in a real GTK/WebKit window; no workspace is opened."""
import gi
import sys
from pathlib import Path

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

manager = WebKit2.UserContentManager()
manager.register_script_message_handler("result")
result = {"code": 1}
# 预览必须完全离线：任何 http(s)/ftp 资源请求都算失败。
network_hits = []

def on_resource_started(_view, _resource, request):
    uri = request.get_uri() or ""
    if uri.startswith(("http://", "https://", "ftp://")):
        network_hits.append(uri)
        print("NOTE: external resource requested: " + uri, flush=True)

def received(_manager, message):
    text = message.get_js_value().to_string()
    print(text, flush=True)
    # 页面里每条 NOTE 都是一次真实断言前的上下文，只有最终的 PASS/FAIL 才算判决。
    if text.startswith("PASS:"):
        if network_hits:
            print("FAIL: live preview must stay offline, but WebKit requested: " + ", ".join(network_hits), flush=True)
            result["code"] = 1
        else:
            print("NOTE: no external resource was requested during the run", flush=True)
            result["code"] = 0
        Gtk.main_quit()
    elif text.startswith("FAIL:"):
        result["code"] = 1
        Gtk.main_quit()

manager.connect("script-message-received::result", received)
view = WebKit2.WebView.new_with_user_content_manager(manager)
view.connect("resource-load-started", on_resource_started)
window = Gtk.Window(title="MyNovel isolated GUI regression")
window.set_default_size(900, 700)
window.add(view)
window.connect("destroy", lambda *_: Gtk.main_quit() if Gtk.main_level() else None)
window.show_all()
# 让窗口管理器真的激活它。没有这一句，夹具窗口可能只是「显示出来」而没有焦点，
# document.hasFocus() 就是 false —— 需要真实焦点的用例（输入法组合、合成键盘事件、
# 打字机滚动）会当场判「不可聚焦」，而失败原因和被测代码毫无关系。
window.present()
view.load_uri(Path(sys.argv[1]).resolve().as_uri())

def timeout():
    print("FAIL: WebKit fixture timed out", flush=True)
    Gtk.main_quit()
    return False

GLib.timeout_add_seconds(30, timeout)
Gtk.main()
window.destroy()
sys.exit(result["code"])
