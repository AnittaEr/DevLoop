"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Client island on the home page. The button itself is the existing shadcn/ui
 * `Button` component; this wrapper only adds the click behaviour and the
 * status line the e2e interaction spec asserts on.
 */
export function GetStartedButton() {
  const [clicked, setClicked] = useState(false);

  return (
    <div className="flex flex-col items-center gap-3">
      <Button onClick={() => setClicked(true)}>Get started</Button>
      <p data-testid="get-started-status" aria-live="polite">
        {clicked ? "Get started pressed" : "Get started not pressed yet"}
      </p>
    </div>
  );
}
