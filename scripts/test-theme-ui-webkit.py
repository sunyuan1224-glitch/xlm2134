"""Isolated real WebKit theme/menu check with screenshot artifacts."""
import gi
import sys
from pathlib import Path
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

page = Path(sys.argv[1]).resolve()
manager = WebKit2.UserContentManager()
manager.register_script_message_handler("result")
view = WebKit2.WebView.new_with_user_content_manager(manager)
result = {"code": 1}
network_hits = []

def screenshot_done(widget, response, name):
    try:
        surface = widget.get_snapshot_finish(response)
        surface.write_to_png(str(page.parent / (name + ".png")))
    except Exception as error:
        print("FAIL: screenshot: " + str(error), flush=True)
        result["code"] = 1
        Gtk.main_quit()

def received(_manager, message):
    text = message.get_js_value().to_string()
    print(text, flush=True)
    if text.startswith("SHOT:"):
        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, screenshot_done, text[5:].strip())
    elif text.startswith("PASS:"):
        result["code"] = 1 if network_hits else 0
        if network_hits:
            print("FAIL: external requests: " + str(network_hits), flush=True)
        Gtk.main_quit()
    elif text.startswith("FAIL:"):
        Gtk.main_quit()

def resource_started(_view, _resource, request):
    uri = request.get_uri() or ""
    if uri.startswith(("http://", "https://", "ftp://")):
        network_hits.append(uri)

manager.connect("script-message-received::result", received)
view.connect("resource-load-started", resource_started)
window = Gtk.Window(title="MyNovel isolated pink-white UI check")
window.set_default_size(1280, 840)
window.add(view)
window.show_all()
view.load_uri(page.as_uri())
def timeout():
    print("FAIL: theme UI fixture timed out", flush=True)
    Gtk.main_quit()
    return False
GLib.timeout_add_seconds(30, timeout)
Gtk.main()
window.destroy()
sys.exit(result["code"])
