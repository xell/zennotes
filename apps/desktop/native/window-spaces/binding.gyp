{
  "targets": [
    {
      "target_name": "window_spaces",
      "sources": ["window_spaces.mm"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"],
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "link_settings": {
        "libraries": ["-framework Cocoa", "-framework CoreGraphics"]
      }
    }
  ]
}
