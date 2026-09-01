import assert from "node:assert/strict";
import test from "node:test";
import {
  observeFloatingViewportChanges,
  placeFloatingMenu,
} from "../src/lib/floatingMenu.js";

const viewport = { top: 0, left: 0, width: 400, height: 800 };

test("places an account menu below when it fits", () => {
  assert.deepEqual(
    placeFloatingMenu(
      { top: 100, bottom: 140, right: 300 },
      { width: 220, height: 200 },
      viewport,
    ),
    {
      top: 148,
      left: 80,
      maxHeight: 640,
      maxWidth: 376,
      side: "below",
    },
  );
});

test("flips an account menu above a bottom-edge trigger", () => {
  assert.deepEqual(
    placeFloatingMenu(
      { top: 700, bottom: 740, right: 300 },
      { width: 220, height: 300 },
      viewport,
    ),
    {
      top: 392,
      left: 80,
      maxHeight: 680,
      maxWidth: 376,
      side: "above",
    },
  );
});

test("uses the larger side and constrains an oversized menu", () => {
  assert.deepEqual(
    placeFloatingMenu(
      { top: 300, bottom: 340, right: 300 },
      { width: 220, height: 500 },
      { top: 0, left: 0, width: 400, height: 600 },
    ),
    {
      top: 12,
      left: 80,
      maxHeight: 280,
      maxWidth: 376,
      side: "above",
    },
  );
});

test("keeps the menu inside horizontal visual-viewport margins", () => {
  const placement = placeFloatingMenu(
    { top: 100, bottom: 140, right: 80 },
    { width: 220, height: 100 },
    { top: 30, left: 20, width: 320, height: 500 },
  );

  assert.equal(placement.left, 32);
  assert.equal(placement.maxWidth, 296);
  assert.equal(placement.top, 148);
});

test("observes and cleans up visual-viewport changes", () => {
  const viewport = new EventTarget();
  let changeCount = 0;
  const stopObserving = observeFloatingViewportChanges(
    viewport,
    () => changeCount += 1,
  );

  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(changeCount, 2);

  stopObserving();
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(changeCount, 2);
});
