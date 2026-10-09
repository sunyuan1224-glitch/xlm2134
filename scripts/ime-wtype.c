/*
 * 极小的按键注入工具（只依赖本地已有的 wayland-client + xkbcommon，不新增任何依赖）：
 *
 *   ime-wtype [--delay MS] <spec>...
 *
 * spec 形式：
 *   text:nihao        逐字输入 ASCII（走真实键盘事件，因此会被 fcitx5/rime 接管）
 *   key:Return        按一次具名按键（Return/space/BackSpace/Escape/Tab/1..9/...）
 *   chord:ctrl+slash  Ctrl 组合键（用于验证 Ctrl+/ 与组合态并存）
 *   sleep:200         等待若干毫秒
 *
 * 事件从 zwp_virtual_keyboard_manager_v1 进入合成器，等价于硬件键盘输入：
 * 合成器 → 输入法（fcitx5，input-method-v2 键盘抓取）→ 客户端 text-input-v3。
 * 因此这是在真实候选窗下验收输入法行为，而不是伪造 Unicode 文本。
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "virtual-keyboard-client-protocol.h"

#define XKB_MASK_SHIFT 1u
#define XKB_MASK_CONTROL 4u

struct state {
  struct wl_display *display;
  struct wl_seat *seat;
  struct zwp_virtual_keyboard_manager_v1 *manager;
  struct zwp_virtual_keyboard_v1 *keyboard;
  struct xkb_context *ctx;
  struct xkb_keymap *keymap;
  int delay_ms;
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  struct state *st = data;
  if (strcmp(interface, wl_seat_interface.name) == 0) {
    st->seat = wl_registry_bind(registry, name, &wl_seat_interface, version < 5 ? version : 5);
  } else if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
    st->manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener registry_listener = { registry_global, registry_global_remove };

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static void send_keymap(struct state *st) {
  char *text = xkb_keymap_get_as_string(st->keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
  if (!text) {
    fprintf(stderr, "ime-wtype: cannot serialize keymap\n");
    exit(2);
  }
  size_t size = strlen(text) + 1;
  int fd = memfd_create("ime-wtype-keymap", 0);
  if (fd < 0 || write(fd, text, size) != (ssize_t)size) {
    fprintf(stderr, "ime-wtype: cannot stage keymap: %s\n", strerror(errno));
    exit(2);
  }
  lseek(fd, 0, SEEK_SET);
  zwp_virtual_keyboard_v1_keymap(st->keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
  close(fd);
  free(text);
}

/* 在 keymap 里找一个能产生该 keysym 的键：返回 keycode，并说明是否需要 Shift。 */
static uint32_t find_key(struct state *st, xkb_keysym_t sym, int *shift) {
  xkb_keycode_t min = xkb_keymap_min_keycode(st->keymap);
  xkb_keycode_t max = xkb_keymap_max_keycode(st->keymap);
  for (xkb_keycode_t kc = min; kc <= max; kc++) {
    xkb_layout_index_t layouts = xkb_keymap_num_layouts_for_key(st->keymap, kc);
    for (xkb_layout_index_t l = 0; l < layouts; l++) {
      xkb_level_index_t levels = xkb_keymap_num_levels_for_key(st->keymap, kc, l);
      for (xkb_level_index_t lv = 0; lv < levels && lv < 2; lv++) {
        const xkb_keysym_t *syms = NULL;
        int count = xkb_keymap_key_get_syms_by_level(st->keymap, kc, l, lv, &syms);
        for (int i = 0; i < count; i++) {
          if (syms[i] == sym) {
            *shift = lv == 1;
            return kc;
          }
        }
      }
    }
  }
  return 0;
}

static void tap(struct state *st, uint32_t keycode, uint32_t mods) {
  // 协议里传的是未映射的 evdev 码；合成器（wlroots/niri 系）在翻译时统一 +8。
  if (keycode > 8) keycode -= 8;
  if (mods) zwp_virtual_keyboard_v1_modifiers(st->keyboard, mods, 0, 0, 0);
  zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), keycode, WL_KEYBOARD_KEY_STATE_PRESSED);
  wl_display_flush(st->display);
  if (st->delay_ms) usleep((useconds_t)st->delay_ms * 1000);
  zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), keycode, WL_KEYBOARD_KEY_STATE_RELEASED);
  if (mods) zwp_virtual_keyboard_v1_modifiers(st->keyboard, 0, 0, 0, 0);
  wl_display_flush(st->display);
  if (st->delay_ms) usleep((useconds_t)st->delay_ms * 1000);
}

static void type_keysym(struct state *st, xkb_keysym_t sym, const char *what) {
  int shift = 0;
  uint32_t keycode = find_key(st, sym, &shift);
  if (!keycode) {
    fprintf(stderr, "ime-wtype: keymap has no key for %s\n", what);
    exit(2);
  }
  tap(st, keycode, shift ? XKB_MASK_SHIFT : 0);
}

static void type_text(struct state *st, const char *text) {
  for (const char *p = text; *p; p++) {
    type_keysym(st, xkb_utf32_to_keysym((uint32_t)(unsigned char)*p), text);
  }
}

static void press_chord(struct state *st, const char *name) {
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "%s", name);
  char *plus = strchr(buffer, '+');
  if (!plus) {
    fprintf(stderr, "ime-wtype: chord needs modifier+key, got %s\n", name);
    exit(2);
  }
  *plus = 0;
  const char *base = plus + 1;

  xkb_keysym_t modifier = xkb_keysym_from_name(buffer, XKB_KEYSYM_CASE_INSENSITIVE);
  xkb_keysym_t target = strlen(base) == 1 ? xkb_utf32_to_keysym((uint32_t)(unsigned char)base[0])
                                          : xkb_keysym_from_name(base, XKB_KEYSYM_CASE_INSENSITIVE);
  if (!modifier || !target) {
    fprintf(stderr, "ime-wtype: unknown chord %s\n", name);
    exit(2);
  }
  int shift_mod = 0, shift_target = 0;
  uint32_t mod_code = find_key(st, modifier, &shift_mod);
  int target_shift = 0;
  uint32_t code = find_key(st, target, &target_shift);
  if (!mod_code || !code) {
    fprintf(stderr, "ime-wtype: no keycode for chord %s\n", name);
    exit(2);
  }
  (void)shift_target;
  uint32_t mask = XKB_MASK_CONTROL;
  if (strcmp(buffer, "shift") == 0) mask = XKB_MASK_SHIFT;
  else if (strcmp(buffer, "alt") == 0 || strcmp(buffer, "mod1") == 0) mask = 8u;
  else if (strcmp(buffer, "super") == 0 || strcmp(buffer, "logo") == 0) mask = 64u;

  zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), mod_code, WL_KEYBOARD_KEY_STATE_PRESSED);
  if (mod_code > 8) zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), mod_code - 8, WL_KEYBOARD_KEY_STATE_PRESSED);
  zwp_virtual_keyboard_v1_modifiers(st->keyboard, mask, 0, 0, 0);
  wl_display_flush(st->display);
  if (st->delay_ms) usleep((useconds_t)st->delay_ms * 1000);
  tap(st, code, 0);
  if (mod_code > 8) zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), mod_code - 8, WL_KEYBOARD_KEY_STATE_RELEASED);
  zwp_virtual_keyboard_v1_key(st->keyboard, now_ms(), mod_code, WL_KEYBOARD_KEY_STATE_RELEASED);
  zwp_virtual_keyboard_v1_modifiers(st->keyboard, 0, 0, 0, 0);
  wl_display_flush(st->display);
  if (st->delay_ms) usleep((useconds_t)st->delay_ms * 1000);
}

static void press_named(struct state *st, const char *name) {
  if (strlen(name) == 1) {
    type_keysym(st, xkb_utf32_to_keysym((uint32_t)(unsigned char)name[0]), name);
    return;
  }
  xkb_keysym_t sym = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
  if (!sym) {
    fprintf(stderr, "ime-wtype: unknown key name %s\n", name);
    exit(2);
  }
  type_keysym(st, sym, name);
}

int main(int argc, char **argv) {
  struct state st;
  memset(&st, 0, sizeof(st));
  st.delay_ms = 25;

  int first = 1;
  if (argc > 3 && strcmp(argv[1], "--delay") == 0) {
    st.delay_ms = atoi(argv[2]);
    first = 3;
  }
  if (first >= argc) {
    fprintf(stderr, "usage: ime-wtype [--delay MS] text:... key:... chord:... sleep:...\n");
    return 2;
  }

  st.display = wl_display_connect(NULL);
  if (!st.display) {
    fprintf(stderr, "ime-wtype: cannot connect to the Wayland display\n");
    return 2;
  }
  struct wl_registry *registry = wl_display_get_registry(st.display);
  wl_registry_add_listener(registry, &registry_listener, &st);
  wl_display_roundtrip(st.display);
  if (!st.manager || !st.seat) {
    fprintf(stderr, "ime-wtype: compositor has no zwp_virtual_keyboard_manager_v1\n");
    return 2;
  }

  st.ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  struct xkb_rule_names names;
  memset(&names, 0, sizeof(names));
  names.rules = "evdev";
  names.model = "pc105";
  names.layout = "us";
  st.keymap = xkb_keymap_new_from_names(st.ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!st.keymap) {
    fprintf(stderr, "ime-wtype: cannot build a keymap\n");
    return 2;
  }

  st.keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(st.manager, st.seat);
  send_keymap(&st);
  wl_display_flush(st.display);
  usleep(60000);

  for (int i = first; i < argc; i++) {
    if (strncmp(argv[i], "text:", 5) == 0) type_text(&st, argv[i] + 5);
    else if (strncmp(argv[i], "key:", 4) == 0) press_named(&st, argv[i] + 4);
    else if (strncmp(argv[i], "chord:", 6) == 0) press_chord(&st, argv[i] + 6);
    else if (strncmp(argv[i], "sleep:", 6) == 0) usleep((useconds_t)(atoi(argv[i] + 6) * 1000));
    else {
      fprintf(stderr, "ime-wtype: unknown spec %s\n", argv[i]);
      return 2;
    }
  }

  wl_display_flush(st.display);
  usleep(80000);
  zwp_virtual_keyboard_v1_destroy(st.keyboard);
  wl_display_flush(st.display);
  xkb_keymap_unref(st.keymap);
  xkb_context_unref(st.ctx);
  wl_display_disconnect(st.display);
  return 0;
}
