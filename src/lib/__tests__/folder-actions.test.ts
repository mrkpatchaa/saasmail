import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyToFolder,
  deleteFolderForever,
  markFolderRead,
  pinUndo,
} from "@/lib/folder-actions";
import {
  fetchGroupedIds,
  markConversationsRead,
  markPeopleRead,
  purgeMailRows,
  updateMailState,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchGroupedIds: vi.fn(),
  markPeopleRead: vi.fn(),
  markConversationsRead: vi.fn(),
  purgeMailRows: vi.fn(),
  updateMailState: vi.fn(),
}));

const mIds = vi.mocked(fetchGroupedIds);
const mPeopleRead = vi.mocked(markPeopleRead);
const mConvRead = vi.mocked(markConversationsRead);
const mState = vi.mocked(updateMailState);
const mPurge = vi.mocked(purgeMailRows);

type Row = { type: "person" | "group"; id: string; unread: boolean };
function rows(people: number, groups: number): Row[] {
  return [
    ...Array.from({ length: people }, (_, i) => ({
      type: "person" as const,
      id: `p${i}`,
      unread: true,
    })),
    ...Array.from({ length: groups }, (_, i) => ({
      type: "group" as const,
      id: `g${i}`,
      unread: true,
    })),
  ];
}

beforeEach(() => {
  mIds.mockReset();
  mPeopleRead.mockReset().mockResolvedValue(undefined as never);
  mConvRead.mockReset().mockResolvedValue(undefined as never);
  mState.mockReset().mockResolvedValue({ data: [], undo: [] });
  mPurge.mockReset();
});

describe("markFolderRead", () => {
  it("asks for the unread rows of the folder + filters, not the page", async () => {
    mIds.mockResolvedValue({ data: rows(3, 2), total: 5, truncated: false });
    const n = await markFolderRead({
      folder: "inbox",
      recipient: "support@acme.dev",
      category: "promotions",
    });
    expect(mIds).toHaveBeenCalledWith({
      folder: "inbox",
      recipient: "support@acme.dev",
      category: "promotions",
      unread: true,
    });
    expect(n).toBe(5);
    expect(mPeopleRead).toHaveBeenCalledWith(["p0", "p1", "p2"]);
    expect(mConvRead).toHaveBeenCalledWith(["g0", "g1"]);
  });

  it("splits big folders into calls of 100", async () => {
    mIds.mockResolvedValue({
      data: rows(250, 0),
      total: 250,
      truncated: false,
    });
    await markFolderRead({ folder: "inbox" });
    expect(mPeopleRead).toHaveBeenCalledTimes(3);
    expect(mPeopleRead.mock.calls.map((c) => c[0].length)).toEqual([
      100, 100, 50,
    ]);
    expect(mConvRead).not.toHaveBeenCalled();
  });
});

describe("applyToFolder", () => {
  it("patches every matching row in calls of 100 and collects the undo steps", async () => {
    mIds.mockResolvedValue({
      data: rows(120, 1),
      total: 121,
      truncated: false,
    });
    mState
      .mockResolvedValueOnce({
        data: [],
        undo: [
          { kind: "mailbox", refs: ["received:a"], change: { trashed: false } },
        ],
      })
      .mockResolvedValueOnce({
        data: [],
        undo: [
          { kind: "mailbox", refs: ["received:b"], change: { trashed: false } },
        ],
      });
    const res = await applyToFolder({ folder: "inbox" }, { trashed: true });
    expect(res.rows).toBe(121);
    expect(mState).toHaveBeenCalledTimes(2);
    expect(mState.mock.calls[0][0][0]).toEqual({ type: "person", id: "p0" });
    expect(mState.mock.calls[0][1]).toEqual({ trashed: true });
    expect(mState.mock.calls[1][0]).toHaveLength(21);
    expect(res.undo.flatMap((s) => s.refs)).toEqual([
      "received:a",
      "received:b",
    ]);
  });
});

describe("pinUndo", () => {
  it("puts back only the pins a change flipped", () => {
    const rows = [
      { type: "person" as const, id: "p0", pinned: true },
      { type: "group" as const, id: "g0", pinned: false },
    ];
    expect(pinUndo(rows, true)).toEqual({
      items: [{ type: "group", id: "g0" }],
      pinned: false,
    });
    expect(pinUndo(rows, undefined)).toBeNull();
    expect(pinUndo([rows[0]], true)).toBeNull();
  });
});

describe("deleteFolderForever (Empty Trash)", () => {
  it("purges every row, people and groups, in calls of 100", async () => {
    mIds.mockResolvedValue({
      data: rows(150, 2),
      total: 152,
      truncated: false,
    });
    mPurge.mockResolvedValue({ success: true, deleted: 1 });
    const res = await deleteFolderForever({ folder: "trash" });
    expect(mIds).toHaveBeenCalledWith({ folder: "trash" });
    expect(mPurge).toHaveBeenCalledTimes(2);
    expect(mPurge.mock.calls[1][0].at(-1)).toEqual({ type: "group", id: "g1" });
    expect(res).toEqual({ deleted: 152, failed: 0 });
  });

  it("keeps going when one call fails, and reports it", async () => {
    mIds.mockResolvedValue({
      data: rows(150, 0),
      total: 150,
      truncated: false,
    });
    mPurge
      .mockRejectedValueOnce(new Error("Forbidden"))
      .mockResolvedValueOnce({ success: true, deleted: 1 });
    const res = await deleteFolderForever({ folder: "trash" });
    expect(res).toEqual({ deleted: 50, failed: 100 });
  });
});
