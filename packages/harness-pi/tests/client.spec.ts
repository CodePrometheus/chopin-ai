import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NativeWatch, type NativeWatchable, type NativeWatchHandle } from "@earendil-works/chord/watch";
import { describe, expect, it, vi } from "vitest";
import { subscribe, within } from "../src/client.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function source(handle: NativeWatchHandle<number>): NativeWatchable<number> {
  return { get value() { return handle.value; }, watch: async () => handle };
}

describe("client observation", () => {
  it("delivers the acquisition value before queued changes and detaches on stop", async () => {
    const detach = vi.fn();
    const report = vi.fn();
    const watch = new NativeWatch(1, detach, report);
    const changed = vi.fn();
    const failed = vi.fn();
    watch.advance(2, context);
    const stop = subscribe(source(watch), changed, failed);
    await turn();
    expect(changed.mock.calls).toEqual([[1], [2]]);
    stop();
    expect(await watch.closed).toEqual({ kind: "stopped" });
    watch.advance(3, context);
    await turn();
    expect(changed.mock.calls).toEqual([[1], [2]]);
    expect(detach).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("releases a watch acquired after cancellation without starting it", async () => {
    const detach = vi.fn();
    const watch = new NativeWatch(1, detach, vi.fn());
    const start = vi.spyOn(watch, "start");
    const acquired = Promise.withResolvers<NativeWatchHandle<number>>();
    const changed = vi.fn();
    const failed = vi.fn();
    const stop = subscribe({ value: 1, watch: () => acquired.promise }, changed, failed);
    stop();
    acquired.resolve(watch);
    expect(await watch.closed).toEqual({ kind: "stopped" });
    expect(start).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("does not start a watch already ended when it was acquired", async () => {
    const watch = new NativeWatch(1, vi.fn(), vi.fn());
    const start = vi.spyOn(watch, "start");
    watch.end({ kind: "ended" });
    const failed = vi.fn();
    const stop = subscribe(source(watch), vi.fn(), failed);
    await turn();
    expect(start).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    stop();
  });

  it("reports a recoverable source failure and keeps delivering its recovery", async () => {
    const watch = new NativeWatch(1, vi.fn(), vi.fn());
    const changed = vi.fn();
    const failed = vi.fn();
    const stop = subscribe(source(watch), changed, failed);
    try {
      await turn();
      const failure = new Error("source unavailable");
      watch.fail(failure, context);
      await turn();
      expect(failed.mock.calls).toEqual([[failure]]);
      expect(changed.mock.calls).toEqual([[1]]);
      watch.advance(2, context);
      await turn();
      expect(changed.mock.calls).toEqual([[1], [2]]);
    } finally { stop(); }
  });

  it("stops and reports a throwing initial listener", async () => {
    const detach = vi.fn();
    const watch = new NativeWatch(1, detach, vi.fn());
    const failure = new Error("listener failed");
    const failed = vi.fn();
    subscribe(source(watch), () => { throw failure; }, failed);
    expect(await watch.closed).toEqual({ kind: "stopped" });
    await turn();
    expect(failed.mock.calls).toEqual([[failure]]);
    expect(detach).toHaveBeenCalledOnce();
  });
});

describe("client calls", () => {
  it("does not replay application work based on an error's text", async () => {
    let calls = 0;
    const failure = new Error("no route to the service after the write");
    await expect(within({}, async () => { calls++; throw failure; })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});
