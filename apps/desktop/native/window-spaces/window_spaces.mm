// macOS-only. Electron windows never participate in AppKit's window state
// restoration (NSWindow.restorable / encodeRestorableStateWithCoder:), which
// is the mechanism macOS uses to carry a native app's windows back onto their
// Mission Control Spaces after a quit. Confirmed dead for Electron on macOS 26
// (see data/per-window-space-persistence.md). So to make each ZenNotes window
// return to its Space after relaunch, we persist the Space ourselves and
// re-assign it on launch via the private SkyLight / CoreGraphics Services API
// — the same approach BetterTouchTool's "Move Window to Desktop X" uses, which
// works from a normally signed, hardened-runtime app without disabling SIP and
// needs no entitlement.
//
// Identifying a Space — the "space token". Most Spaces have a UUID (the same id
// stored in ~/Library/Preferences/com.apple.spaces.plist), which is the ideal
// key because it survives a reboot. But not every Space has one: a normal
// desktop can report an empty uuid (observed on macOS 26 for the Space the user
// logged in on), and keying purely on UUID makes such a Space invisible —
// windows there capture nothing and are never restored. So a token is the UUID
// when there is one, and "id:<managed-id>" otherwise. The managed id is the
// uint64 the WindowServer assigns per login session, which is stable across an
// app relaunch (the case we care about) though not across a reboot.
//
// A window's CGWindowID is its NSWindow.windowNumber. Note the WindowServer
// only reports a window's Space while that window is on the *visible* Space;
// for anything else it returns nothing, which is why the caller also tracks
// Spaces over time rather than querying once at quit.

#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <string.h>

// --- Private SkyLight (CoreGraphics Services) declarations -------------------
// Undocumented but long-stable; the same set powers yabai, BTT and
// node-mac-spaces. These live in the private SkyLight.framework, which
// CoreGraphics.framework re-exports — so linking -framework CoreGraphics
// resolves them without needing a private-framework .tbd stub at link time.
typedef int CGSConnectionID;
typedef uint64_t CGSSpaceID;

extern "C" {
CGSConnectionID CGSMainConnectionID(void);
// Space(s) a set of windows currently occupy. Returns a CFArray of CFNumber
// (managed space ids). mask 0x7 = current | others | user.
CFArrayRef CGSCopySpacesForWindows(CGSConnectionID cid, int mask, CFArrayRef windowIDs);
// Full display -> Spaces map. CFArray of per-display dicts; each has a "Spaces"
// array of dicts carrying "ManagedSpaceID" (CFNumber) and "uuid" (CFString).
CFArrayRef CGSCopyManagedDisplaySpaces(CGSConnectionID cid);
// Relocate windows to a managed Space *without* switching to it.
void CGSMoveWindowsToManagedSpace(CGSConnectionID cid, CFArrayRef windowIDs, CGSSpaceID spaceID);
}

static const int kCGSAllSpacesMask = 0x7;

// --- Buffer <-> pointer helpers (same convention as the tab-groups addon) ----
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

// The NSWindow behind Electron's BrowserWindow.getNativeWindowHandle() (an
// NSView*), or nil. A nil result is meaningful, not an error: callers use it to
// mean "no particular window, use the primary display".
static NSWindow *WindowFromHandle(napi_env env, napi_value value) {
  void *ptr = nullptr;
  if (!GetPointerFromBuffer(env, value, &ptr) || ptr == nullptr) return nil;
  NSView *view = (__bridge NSView *)ptr;
  return [view window];
}

// A one-element CFArray holding the window id as a 32-bit SInt32 CFNumber —
// the representation the CGS/SkyLight window calls expect. Caller CFReleases.
// (ARC does not manage CoreFoundation objects, so releases are explicit.)
static CFArrayRef CreateWindowIDArray(NSInteger windowNumber) {
  uint32_t wid = (uint32_t)windowNumber;
  CFNumberRef widRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &wid);
  CFArrayRef arr = CFArrayCreate(kCFAllocatorDefault, (const void **)&widRef, 1, &kCFTypeArrayCallBacks);
  CFRelease(widRef);
  return arr;
}

// --- Space identity ---------------------------------------------------------

// The managed id / uuid pair out of a Space dictionary. uuid may come back nil
// or empty, which is exactly the case the token scheme exists to handle.
static bool ReadSpaceEntry(NSDictionary *space, CGSSpaceID *outId, NSString **outUUID) {
  if (![space isKindOfClass:[NSDictionary class]]) return false;
  NSNumber *idNum = space[@"ManagedSpaceID"];
  if (![idNum isKindOfClass:[NSNumber class]]) idNum = space[@"id64"];
  if (![idNum isKindOfClass:[NSNumber class]]) return false;
  *outId = (CGSSpaceID)[idNum unsignedLongLongValue];
  NSString *uuid = space[@"uuid"];
  *outUUID = [uuid isKindOfClass:[NSString class]] ? uuid : nil;
  return true;
}

// The token identifying a Space: its uuid, or "id:<managed-id>" when it has none.
static NSString *SpaceToken(CGSSpaceID managedId, NSString *uuid) {
  if (uuid != nil && uuid.length > 0) return uuid;
  return [NSString stringWithFormat:@"id:%llu", (unsigned long long)managedId];
}

// Walk CGSCopyManagedDisplaySpaces once, invoking `block` for every Space with
// its managed id and token. Handles the CF ownership (Copy => we release).
static void EnumerateManagedSpaces(void (^block)(CGSSpaceID managedId, NSString *token)) {
  CGSConnectionID cid = CGSMainConnectionID();
  CFArrayRef displays = CGSCopyManagedDisplaySpaces(cid);
  if (displays == nullptr) return;
  NSArray *displayList = (__bridge NSArray *)displays;
  for (NSDictionary *display in displayList) {
    if (![display isKindOfClass:[NSDictionary class]]) continue;
    NSArray *spaces = display[@"Spaces"];
    if (![spaces isKindOfClass:[NSArray class]]) continue;
    for (NSDictionary *space in spaces) {
      CGSSpaceID managedId = 0;
      NSString *uuid = nil;
      if (!ReadSpaceEntry(space, &managedId, &uuid)) continue;
      block(managedId, SpaceToken(managedId, uuid));
    }
  }
  CFRelease(displays);
}

static NSString *TokenForManagedId(CGSSpaceID target) {
  __block NSString *found = nil;
  EnumerateManagedSpaces(^(CGSSpaceID managedId, NSString *token) {
    if (found == nil && managedId == target) found = [token copy];
  });
  return found;
}

// Resolve a token back to a live managed id. Handles both forms, and verifies
// the Space still exists so a stale token (Space closed, or ids reshuffled by a
// reboot) fails cleanly instead of moving a window somewhere arbitrary.
static bool ManagedIdForToken(NSString *token, CGSSpaceID *out) {
  __block bool matched = false;
  __block CGSSpaceID result = 0;
  if ([token hasPrefix:@"id:"]) {
    unsigned long long wanted = strtoull([token substringFromIndex:3].UTF8String, nullptr, 10);
    if (wanted == 0) return false;
    EnumerateManagedSpaces(^(CGSSpaceID managedId, NSString *unusedToken) {
      (void)unusedToken;
      if (!matched && managedId == (CGSSpaceID)wanted) {
        matched = true;
        result = managedId;
      }
    });
  } else {
    EnumerateManagedSpaces(^(CGSSpaceID managedId, NSString *candidate) {
      if (!matched && [candidate isEqualToString:token]) {
        matched = true;
        result = managedId;
      }
    });
  }
  if (matched) *out = result;
  return matched;
}

// The display dictionary whose screen `window` is on — matched by the display's
// UUID string, falling back to the first entry (the overwhelmingly common
// single-display case, and a sane default for a window we can't place).
static NSDictionary *DisplayDictForWindow(NSArray *displayList, NSWindow *window) {
  if (displayList.count == 0) return nil;
  NSString *wantedUUID = nil;
  NSScreen *screen = window != nil ? window.screen : nil;
  if (screen != nil) {
    NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
    if ([screenNumber isKindOfClass:[NSNumber class]]) {
      CFUUIDRef displayUUID = CGDisplayCreateUUIDFromDisplayID((CGDirectDisplayID)[screenNumber unsignedIntValue]);
      if (displayUUID != nullptr) {
        CFStringRef str = CFUUIDCreateString(kCFAllocatorDefault, displayUUID);
        if (str != nullptr) {
          wantedUUID = [(__bridge NSString *)str copy];
          CFRelease(str);
        }
        CFRelease(displayUUID);
      }
    }
  }
  if (wantedUUID != nil) {
    for (NSDictionary *display in displayList) {
      if (![display isKindOfClass:[NSDictionary class]]) continue;
      NSString *ident = display[@"Display Identifier"];
      if ([ident isKindOfClass:[NSString class]] && [ident isEqualToString:wantedUUID]) return display;
    }
  }
  NSDictionary *first = displayList[0];
  return [first isKindOfClass:[NSDictionary class]] ? first : nil;
}

// Token of the Space currently *visible* on this window's display (primary
// display when window is nil). This is the capture path that works when
// CGSCopySpacesForWindows comes back empty: a focused window is by definition
// on the visible Space, so the display's current Space is that window's Space.
static NSString *CurrentSpaceTokenForWindow(NSWindow *window) {
  CGSConnectionID cid = CGSMainConnectionID();
  CFArrayRef displays = CGSCopyManagedDisplaySpaces(cid);
  if (displays == nullptr) return nil;
  NSArray *displayList = (__bridge NSArray *)displays;
  NSString *result = nil;
  NSDictionary *display = DisplayDictForWindow(displayList, window);
  if (display != nil) {
    CGSSpaceID managedId = 0;
    NSString *uuid = nil;
    if (ReadSpaceEntry(display[@"Current Space"], &managedId, &uuid)) {
      result = SpaceToken(managedId, uuid);
    }
  }
  CFRelease(displays);
  return result;
}

// --- Exported functions -----------------------------------------------------

// getWindowSpaceId(handle: Buffer): string
// Token of the Space the window is on, or "" if unknown — which includes the
// common case of the window being on a Space that isn't currently visible.
static napi_value GetWindowSpaceId(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  NSString *result = @"";
  if (argc >= 1) {
    NSWindow *window = WindowFromHandle(env, argv[0]);
    NSInteger windowNumber = window != nil ? window.windowNumber : 0;
    if (windowNumber > 0) {
      CGSConnectionID cid = CGSMainConnectionID();
      CFArrayRef windowIDs = CreateWindowIDArray(windowNumber);
      CFArrayRef spaces = CGSCopySpacesForWindows(cid, kCGSAllSpacesMask, windowIDs);
      if (spaces != nullptr) {
        NSArray *spaceList = (__bridge NSArray *)spaces;
        if (spaceList.count > 0) {
          NSNumber *first = spaceList[0];
          if ([first isKindOfClass:[NSNumber class]]) {
            NSString *token = TokenForManagedId((CGSSpaceID)[first unsignedLongLongValue]);
            if (token != nil) result = token;
          }
        }
        CFRelease(spaces);
      }
      CFRelease(windowIDs);
    }
  }

  napi_value out;
  napi_create_string_utf8(env, result.UTF8String, NAPI_AUTO_LENGTH, &out);
  return out;
}

// getCurrentSpaceId(handle: Buffer): string
// Token of the Space visible right now on the window's display. Pass an empty
// buffer for "the primary display". Only trust this for a window known to be on
// the active Space (one that just took focus).
static napi_value GetCurrentSpaceId(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  NSWindow *window = argc >= 1 ? WindowFromHandle(env, argv[0]) : nil;
  NSString *token = CurrentSpaceTokenForWindow(window);

  napi_value out;
  napi_create_string_utf8(env, token != nil ? token.UTF8String : "", NAPI_AUTO_LENGTH, &out);
  return out;
}

// moveWindowToSpaceId(handle: Buffer, token: string): boolean
// Relocate the window to the identified Space without switching to it. False
// when the window has no window number yet or the Space no longer exists.
static napi_value MoveWindowToSpaceId(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  bool moved = false;
  if (argc >= 2) {
    NSWindow *window = WindowFromHandle(env, argv[0]);
    NSInteger windowNumber = window != nil ? window.windowNumber : 0;

    char tokenBuf[128];
    size_t tokenLen = 0;
    napi_get_value_string_utf8(env, argv[1], tokenBuf, sizeof(tokenBuf), &tokenLen);
    NSString *token = [NSString stringWithUTF8String:tokenBuf];

    CGSSpaceID managedId = 0;
    if (windowNumber > 0 && token.length > 0 && ManagedIdForToken(token, &managedId)) {
      CGSConnectionID cid = CGSMainConnectionID();
      CFArrayRef windowIDs = CreateWindowIDArray(windowNumber);
      CGSMoveWindowsToManagedSpace(cid, windowIDs, managedId);
      CFRelease(windowIDs);
      moved = true;
    }
  }

  napi_value out;
  napi_get_boolean(env, moved, &out);
  return out;
}

// getAllSpaceIds(): string[]
// Diagnostic-only: a token for every Space the WindowServer knows, in
// display/Space order.
static napi_value GetAllSpaceIds(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_array(env, &result);
  __block uint32_t i = 0;
  EnumerateManagedSpaces(^(CGSSpaceID managedId, NSString *token) {
    (void)managedId;
    napi_value entry;
    napi_create_string_utf8(env, token.UTF8String, NAPI_AUTO_LENGTH, &entry);
    napi_set_element(env, result, i++, entry);
  });
  return result;
}

// setWindowSpaceBound(handle: Buffer): number
// Keep the window bound to one Space rather than following the app onto the
// active Space: clear CanJoinAllSpaces (0x1) / MoveToActiveSpace (0x2) and set
// Managed (0x4). Measured as already the case for Electron windows
// (collectionBehavior reads 132 = FullScreenPrimary|Managed), so this is a
// guard against that changing, not a fix. Returns the resulting mask.
static napi_value SetWindowSpaceBound(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  NSWindowCollectionBehavior behavior = 0;
  NSWindow *window = argc >= 1 ? WindowFromHandle(env, argv[0]) : nil;
  if (window != nil) {
    behavior = window.collectionBehavior;
    behavior &= ~(NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorMoveToActiveSpace);
    behavior |= NSWindowCollectionBehaviorManaged;
    window.collectionBehavior = behavior;
  }

  napi_value out;
  napi_create_int64(env, (int64_t)behavior, &out);
  return out;
}

// debugWindowSpace(handle: Buffer): object
// Diagnostic-only: window number, collection behaviour, the raw space ids
// reported for this window, and the full managed-spaces table.
static napi_value DebugWindowSpace(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value result;
  napi_create_object(env, &result);

  NSWindow *window = argc >= 1 ? WindowFromHandle(env, argv[0]) : nil;
  NSInteger windowNumber = window != nil ? window.windowNumber : 0;

  napi_value v;
  napi_create_int64(env, (int64_t)windowNumber, &v);
  napi_set_named_property(env, result, "windowNumber", v);

  napi_create_int64(env, window != nil ? (int64_t)window.collectionBehavior : -1, &v);
  napi_set_named_property(env, result, "collectionBehavior", v);

  NSString *currentToken = CurrentSpaceTokenForWindow(window);
  napi_create_string_utf8(env, currentToken != nil ? currentToken.UTF8String : "", NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, result, "currentSpaceId", v);

  napi_value rawIds;
  napi_create_array(env, &rawIds);
  if (windowNumber > 0) {
    CGSConnectionID cid = CGSMainConnectionID();
    CFArrayRef windowIDs = CreateWindowIDArray(windowNumber);
    CFArrayRef spaces = CGSCopySpacesForWindows(cid, kCGSAllSpacesMask, windowIDs);
    if (spaces != nullptr) {
      NSArray *spaceList = (__bridge NSArray *)spaces;
      uint32_t i = 0;
      for (NSNumber *n in spaceList) {
        if (![n isKindOfClass:[NSNumber class]]) continue;
        napi_value e;
        napi_create_int64(env, (int64_t)[n unsignedLongLongValue], &e);
        napi_set_element(env, rawIds, i++, e);
      }
      CFRelease(spaces);
    }
    CFRelease(windowIDs);
  }
  napi_set_named_property(env, result, "rawSpaceIds", rawIds);

  napi_value managed;
  napi_create_array(env, &managed);
  __block uint32_t mi = 0;
  EnumerateManagedSpaces(^(CGSSpaceID managedId, NSString *token) {
    napi_value entry;
    napi_create_object(env, &entry);
    napi_value f;
    napi_create_int64(env, (int64_t)managedId, &f);
    napi_set_named_property(env, entry, "id", f);
    napi_create_string_utf8(env, token.UTF8String, NAPI_AUTO_LENGTH, &f);
    napi_set_named_property(env, entry, "token", f);
    napi_set_element(env, managed, mi++, entry);
  });
  napi_set_named_property(env, result, "managedSpaces", managed);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "getWindowSpaceId", NAPI_AUTO_LENGTH, GetWindowSpaceId, nullptr, &fn);
  napi_set_named_property(env, exports, "getWindowSpaceId", fn);

  napi_create_function(env, "getCurrentSpaceId", NAPI_AUTO_LENGTH, GetCurrentSpaceId, nullptr, &fn);
  napi_set_named_property(env, exports, "getCurrentSpaceId", fn);

  napi_create_function(env, "moveWindowToSpaceId", NAPI_AUTO_LENGTH, MoveWindowToSpaceId, nullptr, &fn);
  napi_set_named_property(env, exports, "moveWindowToSpaceId", fn);

  napi_create_function(env, "getAllSpaceIds", NAPI_AUTO_LENGTH, GetAllSpaceIds, nullptr, &fn);
  napi_set_named_property(env, exports, "getAllSpaceIds", fn);

  napi_create_function(env, "setWindowSpaceBound", NAPI_AUTO_LENGTH, SetWindowSpaceBound, nullptr, &fn);
  napi_set_named_property(env, exports, "setWindowSpaceBound", fn);

  napi_create_function(env, "debugWindowSpace", NAPI_AUTO_LENGTH, DebugWindowSpace, nullptr, &fn);
  napi_set_named_property(env, exports, "debugWindowSpace", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
