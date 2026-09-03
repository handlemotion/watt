import { describe, expect, it } from "vitest";

import { ProtocolError, toWireError } from "./index.js";

describe("host protocol", () => {
  it("preserves safe protocol errors", () => {
    expect(
      toWireError(
        new ProtocolError("bad request", "invalid_request", {
          details: { field: "prompt" },
        }),
      ),
    ).toEqual({
      code: "invalid_request",
      message: "bad request",
      details: { field: "prompt" },
    });
  });

  it("does not serialize unknown exception details", () => {
    expect(toWireError(new Error("secret token"))).toEqual({
      code: "internal_error",
      message: "internal host error",
    });
  });
});
