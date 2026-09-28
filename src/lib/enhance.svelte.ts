import type { SubmitFunction } from "@sveltejs/kit";
import { tick } from "svelte";

/** `use:enhance` callback that tracks a pending state and, when the server rejects a submission, keeps what was typed and shows the error. */
export function pendingForm() {
  let pending = $state(false);
  const enhance: SubmitFunction = () => {
    pending = true;
    return async ({ result, update }) => {
      try {
        await update({ reset: false });
      } finally {
        pending = false;
      }
      if (result.type === "failure") {
        await tick();
        document.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest" });
      }
    };
  };
  return {
    get pending() {
      return pending;
    },
    enhance
  };
}
