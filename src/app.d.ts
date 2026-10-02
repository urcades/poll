import type { Suggestion } from "$lib/suggestion";

declare global {
  namespace App {
    interface PageState {
      /** Set when /new is opened from a description typed on the home page. */
      suggestion?: Suggestion;
    }
  }
}

export {};
