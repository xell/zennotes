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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "getTabGroupHandles", NAPI_AUTO_LENGTH, GetTabGroupHandles, nullptr, &fn);
  napi_set_named_property(env, exports, "getTabGroupHandles", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
