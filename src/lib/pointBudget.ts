/** "7 of 10 points left" / "All 10 points spent" / "3 over: 10 is the most you can spend". */
export function pointsLeftText(left: number, budget: number): string {
  if (left < 0) return `${-left} over: ${budget} is the most you can spend`;
  if (left === 0) return `All ${budget} points spent`;
  return `${left} of ${budget} point${budget === 1 ? "" : "s"} left`;
}

export type PointsState = "open" | "spent" | "over";

export function pointsState(left: number): PointsState {
  return left < 0 ? "over" : left === 0 ? "spent" : "open";
}

/**
 * Svelte action for an allocate ballot's number inputs. Keeps the
 * `[data-points-left]` counter current, caps each input's `max` at what it
 * could still take, disables options still at 0 once the budget is spent,
 * flags overspending (blocking submit via custom validity) while typing, and
 * clamps the edited input down to fit when it's left. The server still
 * validates; without JS the form behaves as before.
 */
export function pointBudget(node: HTMLElement, budget: number) {
  let total = budget;
  const inputs = () => [...node.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  const points = (input: HTMLInputElement) => {
    const value = Math.floor(Number(input.value));
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  function render(active?: HTMLInputElement) {
    const all = inputs();
    const left = total - all.reduce((sum, input) => sum + points(input), 0);
    for (const input of all) {
      input.max = String(points(input) + Math.max(0, left));
      input.disabled = left <= 0 && points(input) === 0 && input !== active;
      input.setCustomValidity("");
    }
    if (left < 0) (active ?? all.find((input) => points(input) > 0))?.setCustomValidity(`That's ${-left} more than the ${total} points available.`);
    const counter = node.querySelector<HTMLElement>("[data-points-left]");
    if (counter) {
      counter.textContent = pointsLeftText(left, total);
      counter.dataset.state = pointsState(left);
    }
  }

  const onInput = (event: Event) => render(event.target as HTMLInputElement);
  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const left = total - inputs().reduce((sum, other) => sum + points(other), 0);
    // Leaving a field that overspent: take it down to the most it can hold.
    if (left < 0) input.value = String(Math.max(0, points(input) + left));
    render();
  };

  node.addEventListener("input", onInput);
  node.addEventListener("change", onChange);
  render();

  return {
    update(next: number) {
      total = next;
      render();
    },
    destroy() {
      node.removeEventListener("input", onInput);
      node.removeEventListener("change", onChange);
    }
  };
}
