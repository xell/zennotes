{
  "targets": [
    {
      "target_name": "tab_groups",
      "sources": ["tab_groups.mm"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"],
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "link_settings": {
        "libraries": ["-framework Cocoa"]
      }
    }
  ]
}
