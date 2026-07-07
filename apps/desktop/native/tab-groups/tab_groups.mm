// macOS-only. Electron's JS APIs can drive native window tabbing
// (addTabbedWindow, mergeAllWindows, etc.) but expose no way to *observe*
// it — there is no event or getter for "which windows are tabbed with this
// one right now". That makes tab groups changed by dragging tabs by hand
// invisible to the app. NSWindow.tabbedWindows has the real answer, so this
// addon is a thin bridge: given the NSView* handle Electron's
// BrowserWindow.getNativeWindowHandle() returns, look up its NSWindow and
// report every window currently tabbed with it (by the same NSView*
// handles), so the main process can match them back to BrowserWindow
// instances and persist the real, current grouping.

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <string.h>

static bool GetPointerFromBuffer(napi_env env, napi_value value, void **outPtr) {
  bool isBuffer = false;
  napi_is_buffer(env, value, &isBuffer);
  if (!isBuffer) return false;
  void *data = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, value, &data, &length);
  if (!data || length < sizeof(void *)) return false;
  memcpy(outPtr, data, sizeof(void *));
  return true;
}

static napi_value MakeHandleBuffer(napi_env env, NSView *view) {
  napi_value buf;
  void *data = nullptr;
  napi_create_buffer(env, sizeof(void *), &data, &buf);
  void *raw = (__bridge void *)view;
  memcpy(data, &raw, sizeof(void *));
  return buf;
}

// getTabGroupHandles(handle: Buffer): Buffer[]
static napi_value GetTabGroupHandles(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value result;
  napi_create_array(env, &result);
  if (argc < 1) return result;

  void *ptr = nullptr;
  if (!GetPointerFromBuffer(env, argv[0], &ptr) || ptr == nullptr) return result;

  NSView *view = (__bridge NSView *)ptr;
  NSWindow *window = [view window];
  if (window == nil) return result;

  NSMutableArray<NSWindow *> *all = [NSMutableArray array];
  if (window.tabbedWindows != nil) {
    [all addObjectsFromArray:window.tabbedWindows];
  }
  if (![all containsObject:window]) {
    [all addObject:window];
  }

  uint32_t i = 0;
  for (NSWindow *w in all) {
    napi_set_element(env, result, i++, MakeHandleBuffer(env, w.contentView));
  }
  return result;
}

// getContentTopInset(handle: Buffer): number
//
// hiddenInset windows intentionally let the web content extend under the
// title bar area (that's the whole point — it's how the app draws its own
// custom title bar in the single-window case). When a native tab bar is
// added, it does not shrink the content view either. NSWindow.contentLayoutRect
// answers "how much is reserved for chrome", but that reservation is
// deliberately generous — sized for the tab bar's expanded (pre-settle)
// two-row look, even once it has visually collapsed into one combined row —
// which left a real, visible gap of unused space once collapsed. What we
// actually want is "where do the traffic lights really end", which is a
// question the standard window buttons can answer directly and precisely,
// via the same public API Electron itself uses for trafficLightPosition.
static napi_value GetContentTopInset(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  double topInset = 0;
  if (argc >= 1) {
    void *ptr = nullptr;
    if (GetPointerFromBuffer(env, argv[0], &ptr) && ptr != nullptr) {
      NSView *view = (__bridge NSView *)ptr;
      NSWindow *window = [view window];
      if (window != nil) {
        NSButton *closeButton = [window standardWindowButton:NSWindowCloseButton];
        if (closeButton != nil) {
          NSRect buttonInWindow = [closeButton convertRect:closeButton.bounds toView:nil];
          topInset = window.frame.size.height - buttonInWindow.origin.y;
        } else {
          NSRect frame = window.frame;
          NSRect layout = window.contentLayoutRect;
          topInset = frame.size.height - (layout.origin.y + layout.size.height);
        }
        if (topInset < 0) topInset = 0;
      }
    }
  }
  napi_value result;
  napi_create_double(env, topInset, &result);
  return result;
}

// getChromeDebug(handle: Buffer): object
//
// Diagnostic-only: dumps every geometry number we could plausibly use for
// the top inset, plus the frame of every view AppKit has layered in above
// the content view, so we can see which one actually matches what's drawn
// on screen instead of guessing.
static napi_value GetChromeDebug(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value result;
  napi_create_object(env, &result);
  if (argc < 1) return result;

  void *ptr = nullptr;
  if (!GetPointerFromBuffer(env, argv[0], &ptr) || ptr == nullptr) return result;

  NSView *view = (__bridge NSView *)ptr;
  NSWindow *window = [view window];
  if (window == nil) return result;

  NSRect frame = window.frame;
  NSRect layout = window.contentLayoutRect;
  NSRect contentViewFrame = window.contentView.frame;

  napi_value v;
  napi_create_double(env, frame.size.height, &v);
  napi_set_named_property(env, result, "windowFrameHeight", v);
  napi_create_double(env, layout.origin.y, &v);
  napi_set_named_property(env, result, "contentLayoutOriginY", v);
  napi_create_double(env, layout.size.height, &v);
  napi_set_named_property(env, result, "contentLayoutHeight", v);
  napi_create_double(env, frame.size.height - (layout.origin.y + layout.size.height), &v);
  napi_set_named_property(env, result, "insetFromContentLayoutRect", v);
  napi_create_double(env, contentViewFrame.size.height, &v);
  napi_set_named_property(env, result, "contentViewFrameHeight", v);
  napi_create_double(env, frame.size.height - contentViewFrame.size.height, &v);
  napi_set_named_property(env, result, "insetFromContentViewFrame", v);

  NSButton *closeButton = [window standardWindowButton:NSWindowCloseButton];
  if (closeButton != nil) {
    NSRect buttonInWindow = [closeButton convertRect:closeButton.bounds toView:nil];
    napi_create_double(env, buttonInWindow.origin.y, &v);
    napi_set_named_property(env, result, "closeButtonBottomY", v);
    napi_create_double(env, buttonInWindow.size.height, &v);
    napi_set_named_property(env, result, "closeButtonHeight", v);
    napi_create_double(env, frame.size.height - buttonInWindow.origin.y, &v);
    napi_set_named_property(env, result, "insetFromCloseButtonBottom", v);
  }

  napi_value siblings;
  napi_create_array(env, &siblings);
  NSView *contentSuperview = window.contentView.superview;
  uint32_t i = 0;
  if (contentSuperview != nil) {
    for (NSView *sibling in contentSuperview.subviews) {
      if (sibling == window.contentView) continue;
      napi_value entry;
      napi_create_object(env, &entry);
      napi_value className;
      const char *name = class_getName([sibling class]);
      napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &className);
      napi_set_named_property(env, entry, "class", className);
      napi_create_double(env, sibling.frame.origin.x, &v);
      napi_set_named_property(env, entry, "x", v);
      napi_create_double(env, sibling.frame.origin.y, &v);
      napi_set_named_property(env, entry, "y", v);
      napi_create_double(env, sibling.frame.size.width, &v);
      napi_set_named_property(env, entry, "width", v);
      napi_create_double(env, sibling.frame.size.height, &v);
      napi_set_named_property(env, entry, "height", v);
      napi_set_element(env, siblings, i++, entry);
    }
  }
  napi_set_named_property(env, result, "siblingViews", siblings);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "getTabGroupHandles", NAPI_AUTO_LENGTH, GetTabGroupHandles, nullptr, &fn);
  napi_set_named_property(env, exports, "getTabGroupHandles", fn);

  napi_value insetFn;
  napi_create_function(env, "getContentTopInset", NAPI_AUTO_LENGTH, GetContentTopInset, nullptr, &insetFn);
  napi_set_named_property(env, exports, "getContentTopInset", insetFn);

  napi_value debugFn;
  napi_create_function(env, "getChromeDebug", NAPI_AUTO_LENGTH, GetChromeDebug, nullptr, &debugFn);
  napi_set_named_property(env, exports, "getChromeDebug", debugFn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
