import { describe, expect, it, vi } from "vitest";
import { getPublishedNoteContextMenuItems } from "./Sidebar";

describe("published note context menu items", () => {
  it("offers publishing for a private note", async () => {
    const onManage = vi.fn();
    const onUnpublish = vi.fn();

    const items = getPublishedNoteContextMenuItems({
      published: false,
      onManage,
      onUnpublish,
    });

    expect(items.map((item) => item.label)).toEqual(["Publish note…"]);
    await items[0]?.onSelect?.();
    expect(onManage).toHaveBeenCalledOnce();
    expect(onUnpublish).not.toHaveBeenCalled();
  });

  it("offers management and unpublishing for a public note", async () => {
    const onManage = vi.fn();
    const onUnpublish = vi.fn();

    const items = getPublishedNoteContextMenuItems({
      published: true,
      onManage,
      onUnpublish,
    });

    expect(items.map((item) => item.label)).toEqual([
      "Manage published note…",
      "Unpublish note",
    ]);
    expect(items[1]?.danger).toBe(true);
    await items[1]?.onSelect?.();
    expect(onUnpublish).toHaveBeenCalledOnce();
  });
});
