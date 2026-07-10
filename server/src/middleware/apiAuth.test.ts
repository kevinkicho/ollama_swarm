import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { extractSwarmToken } from "./apiAuth.js";

function fakeReq(headers: Record<string, string | string[] | undefined>): Request {
  return { headers } as unknown as Request;
}

describe("extractSwarmToken", () => {
  it("reads X-Swarm-Token", () => {
    assert.equal(extractSwarmToken(fakeReq({ "x-swarm-token": "abc" })), "abc");
  });

  it("reads Bearer Authorization", () => {
    assert.equal(
      extractSwarmToken(fakeReq({ authorization: "Bearer secret-token" })),
      "secret-token",
    );
  });

  it("returns undefined when missing", () => {
    assert.equal(extractSwarmToken(fakeReq({})), undefined);
  });
});
