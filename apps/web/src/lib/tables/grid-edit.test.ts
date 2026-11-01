import { describe, expect, it, vi } from "vitest";
import { commitPendingGridEdit } from "./grid-edit";

describe("commitPendingGridEdit", () => {
  it("resolves immediately when no cell is editing", async () => {
    const stopEditing = vi.fn();
    const nextFrame = vi.fn();
    await commitPendingGridEdit(
      { getEditingCells: () => [], stopEditing },
      nextFrame,
    );
    expect(stopEditing).not.toHaveBeenCalled();
    expect(nextFrame).not.toHaveBeenCalled();
  });

  it("waits for the grid boundary without stopping a draining edit", async () => {
    const order: string[] = [];
    const stopEditing = vi.fn();
    const promise = commitPendingGridEdit(
      { getEditingCells: () => [], stopEditing },
      (callback) => {
        order.push("frame");
        callback();
      },
      true,
    );
    order.push("returned");
    await promise;

    expect(stopEditing).not.toHaveBeenCalled();
    expect(order).toEqual(["frame", "returned"]);
  });

  it("commits and waits for the next frame when a cell is editing", async () => {
    const order: string[] = [];
    const promise = commitPendingGridEdit(
      {
        getEditingCells: () => [{}],
        stopEditing: (cancel) => order.push(`stop:${String(cancel)}`),
      },
      (callback) => {
        order.push("frame");
        callback();
      },
    );
    order.push("returned");
    await promise;
    expect(order).toEqual(["stop:false", "frame", "returned"]);
  });
});
