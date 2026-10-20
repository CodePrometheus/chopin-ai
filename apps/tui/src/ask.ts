import type { Component, Container, TUI } from "@earendil-works/pi-tui";

/** Where dialogs take turns on the screen: in place of the editor, or on a screen of their own. */
export interface Stage {
  readonly tui: TUI;
  /** Shows `component` there and gives it the keys. */
  show(component: Component): void;
  /** Gives the place back to what it held before. */
  restore(): void;
}

/** A stage in `slot`, which holds `resting`, such as the editor, whenever no dialog is shown. */
export function stageIn(tui: TUI, slot: Container, resting?: Component): Stage {
  const hold = (component: Component | undefined) => {
    slot.clear();
    if (component !== undefined) {
      slot.addChild(component);
      tui.setFocus(component);
    }
    tui.requestRender();
  };
  return { tui, show: hold, restore: () => hold(resting) };
}
