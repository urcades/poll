/**
 * Svelte action for a group of checkboxes with a maximum: once `max` are
 * checked, the unchecked ones are disabled (and greyed by CSS) until one is
 * unchecked, so the limit is visible up front instead of failing on submit.
 * The server still validates; without JS the form behaves as before.
 */
export function limitChoices(node: HTMLElement, max: number | null) {
  let limit = max;

  function apply() {
    const boxes = [...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const full = limit !== null && boxes.filter((box) => box.checked).length >= limit;
    for (const box of boxes) box.disabled = full && !box.checked;
  }

  node.addEventListener("change", apply);
  apply();

  return {
    update(next: number | null) {
      limit = next;
      apply();
    },
    destroy() {
      node.removeEventListener("change", apply);
    }
  };
}
