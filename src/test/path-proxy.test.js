import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshHome, cleanup, require } from "./setup.js";

describe("path-proxy", () => {
  let home;

  beforeEach(() => {
    home = freshHome();
    require("../db/migrate").migrate();
  });
  afterEach(() => {
    cleanup(home);
  });

  it("matches service prefixes", () => {
    const pp = require("../lib/path-proxy");
    expect(pp.match("/code")).toMatchObject({ kind: "service", type: "code-server" });
    expect(pp.match("/code/")).toMatchObject({ kind: "service", type: "code-server" });
    expect(pp.match("/code/?folder=/x")).toMatchObject({ kind: "service", type: "code-server" });
    expect(pp.match("/files/share/abc")).toMatchObject({ kind: "service", type: "filebrowser" });
    expect(pp.match("/db/")).toMatchObject({ kind: "service", type: "dbgate" });
  });

  it("does not match lookalike prefixes or unrelated paths", () => {
    const pp = require("../lib/path-proxy");
    expect(pp.match("/codex")).toBeNull();
    expect(pp.match("/database")).toBeNull();
    expect(pp.match("/api/projects")).toBeNull();
    expect(pp.match("/")).toBeNull();
    expect(pp.match("/dev/")).toBeNull();
    expect(pp.match("/dev/abc")).toBeNull();
  });

  it("matches dev preview paths with the port", () => {
    const pp = require("../lib/path-proxy");
    expect(pp.match("/dev/5173")).toMatchObject({ kind: "dev", port: 5173, prefix: "/dev/5173" });
    expect(pp.match("/dev/5173/assets/x.js")).toMatchObject({ kind: "dev", port: 5173 });
    // /dev/51730 farkli bir port; prefix eslesmesi rakami yarida kesmemeli
    expect(pp.match("/dev/51730/x")).toMatchObject({ kind: "dev", port: 51730 });
  });

  it("matches code-server port-forward links before the /code prefix", () => {
    const pp = require("../lib/path-proxy");
    expect(pp.matchCodeProxy("/code/proxy/8000")).toEqual({ port: 8000, tail: "/" });
    expect(pp.matchCodeProxy("/code/proxy/8000/")).toEqual({ port: 8000, tail: "/" });
    expect(pp.matchCodeProxy("/code/proxy/8000/api?x=1")).toEqual({ port: 8000, tail: "/api?x=1" });
    expect(pp.matchCodeProxy("/code/proxyfoo")).toBeNull();
    expect(pp.matchCodeProxy("/code/")).toBeNull();
  });

  it("bypasses auth only for filebrowser share paths", () => {
    const pp = require("../lib/path-proxy");
    const files = pp.match("/files/share/abc");
    expect(pp.isBypassPath(files, "/files/share/abc")).toBe(true);
    expect(pp.isBypassPath(files, "/files/static/app.js")).toBe(true);
    expect(pp.isBypassPath(files, "/files/settings")).toBe(false);
    const code = pp.match("/code/share/abc");
    expect(pp.isBypassPath(code, "/code/share/abc")).toBe(false);
  });

  it("returns 503 with a service-specific message when the service is not registered", () => {
    const pp = require("../lib/path-proxy");
    const m = pp.match("/code/");
    const written = { code: null, body: "" };
    const res = {
      writeHead: (code) => {
        written.code = code;
      },
      end: (body) => {
        written.body = body || "";
      }
    };
    pp.forwardWeb({ url: "/code/", headers: {} }, res, m);
    expect(written.code).toBe(503);
    expect(written.body).toContain("code-server kurulu degil");
  });
});
