export type FloatingMenuAnchor = {
  top: number;
  bottom: number;
  right: number;
};

export type FloatingMenuSize = {
  width: number;
  height: number;
};

export type FloatingMenuViewport = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type FloatingMenuPlacement = {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  side: "above" | "below";
};

export type FloatingViewportEventSource = {
  addEventListener(type: "resize" | "scroll", listener: EventListener): void;
  removeEventListener(type: "resize" | "scroll", listener: EventListener): void;
};

export function observeFloatingViewportChanges(
  viewport: FloatingViewportEventSource | null | undefined,
  onChange: EventListener,
) {
  if (!viewport) return () => undefined;

  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function placeFloatingMenu(
  anchor: FloatingMenuAnchor,
  menu: FloatingMenuSize,
  viewport: FloatingMenuViewport,
  margin = 12,
  gap = 8,
): FloatingMenuPlacement {
  const topLimit = viewport.top + margin;
  const leftLimit = viewport.left + margin;
  const bottomLimit = viewport.top + viewport.height - margin;
  const rightLimit = viewport.left + viewport.width - margin;
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const effectiveWidth = Math.min(Math.max(0, menu.width), maxWidth);
  const availableBelow = Math.max(0, bottomLimit - anchor.bottom - gap);
  const availableAbove = Math.max(0, anchor.top - gap - topLimit);
  const openBelow =
    menu.height <= availableBelow ||
    (menu.height > availableAbove && availableBelow >= availableAbove);
  const maxHeight = openBelow ? availableBelow : availableAbove;
  const visibleHeight = Math.min(Math.max(0, menu.height), maxHeight);
  const maxLeft = Math.max(leftLimit, rightLimit - effectiveWidth);

  return {
    top: openBelow
      ? anchor.bottom + gap
      : Math.max(topLimit, anchor.top - gap - visibleHeight),
    left: clamp(anchor.right - effectiveWidth, leftLimit, maxLeft),
    maxHeight,
    maxWidth,
    side: openBelow ? "below" : "above",
  };
}
