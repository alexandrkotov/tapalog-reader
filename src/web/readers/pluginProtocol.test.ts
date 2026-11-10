import { expect, test } from "bun:test";
import { frameAddress, parseFromFrame } from "./pluginProtocol";

test("the messages a frame may send are taken in the shape they have", () => {
  expect(parseFromFrame({ t: "ready" })).toEqual({ t: "ready" });
  expect(parseFromFrame({ t: "mounted", extra: "ignored" })).toEqual({ t: "mounted" });
  expect(parseFromFrame({ t: "failed", message: "no file" })).toEqual({ t: "failed", message: "no file" });
  expect(parseFromFrame({ t: "view", view: { page: 3 }, label: "page 3" })).toEqual({ t: "view", view: { page: 3 }, label: "page 3" });
  expect(parseFromFrame({ t: "error", title: "Could not open", text: "damaged" })).toEqual({ t: "error", title: "Could not open", text: "damaged" });
  expect(parseFromFrame({ t: "need-file", id: 7 })).toEqual({ t: "need-file", id: 7 });
  const image = new Blob(["x"], { type: "image/png" });
  expect(parseFromFrame({ t: "cover", image })).toEqual({ t: "cover", image });
  expect(parseFromFrame({ t: "cover-failed", message: "empty", retry: true })).toEqual({ t: "cover-failed", message: "empty", retry: true });
});

test("what is missing is filled in, and what is too long is cut", () => {
  expect(parseFromFrame({ t: "failed" })).toEqual({ t: "failed", message: "the plugin failed" });
  expect(parseFromFrame({ t: "view" })).toEqual({ t: "view", view: null, label: "" });
  expect(parseFromFrame({ t: "view", view: 1, label: "x".repeat(500) })).toMatchObject({ label: "x".repeat(200) });
  expect(parseFromFrame({ t: "error", title: 5, text: "y".repeat(5000) })).toEqual({ t: "error", title: "", text: "y".repeat(2000) });
  expect(parseFromFrame({ t: "cover-failed", message: "", retry: "yes" })).toEqual({ t: "cover-failed", message: "no cover", retry: false }); // only a true retries
});

test("anything else a plugin might post is not a message", () => {
  for (const data of [null, undefined, 5, "ready", [], {}, { t: 1 }, { t: "init" }, { t: "file", id: 1 }, { t: "destroy" }, { t: "need-file", id: "1" }, { t: "need-file", id: 1.5 }, { t: "cover", image: "not an image" }, { t: "cover", image: { width: 1 } }]) {
    expect([data, parseFromFrame(data)]).toEqual([data, null]);
  }
});

test("the page of a plugin is addressed by its id", () => {
  expect(frameAddress("sealed")).toBe("/plugin-host/sealed");
  expect(frameAddress("a/b")).toBe("/plugin-host/a%2Fb");
});
