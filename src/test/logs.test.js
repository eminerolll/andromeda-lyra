// routes/logs.js icin getServiceStatus testleri. execFileSync mock'lanir —
// gercek systemctl cagrisi YOK. logs.js child_process'i modul yuklenirken
// destructure ettigi icin mock, logs.js require edilmeden ONCE kurulmali.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { require } from "./setup.js";

const cp = require("child_process");
const realExecFileSync = cp.execFileSync;
const execFileSyncMock = vi.fn();
cp.execFileSync = execFileSyncMock;

const logs = require("../routes/logs");

describe("logs — getServiceStatus", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    cp.execFileSync = realExecFileSync;
  });

  it("aktif unit icin stdout'taki durumu doner", () => {
    execFileSyncMock.mockImplementation((cmd, args) => {
      expect(cmd).toBe("systemctl");
      expect(args).toEqual(["is-active", "caddy"]);
      return Buffer.from("active\n");
    });
    expect(logs.getServiceStatus("caddy")).toBe("active");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("inactive unit: is-active sifir olmayan kodla cikar ama durumu stdout'a basar", () => {
    // Gercek systemctl davranisi: inactive unit'lerde is-active basarisiz
    // cikar (throw) ama "inactive" metnini yine de stdout'a yazar.
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (args[0] === "is-active") {
        const err = new Error("Command failed");
        err.stdout = Buffer.from("inactive\n");
        err.stderr = Buffer.from("");
        throw err;
      }
      throw new Error("beklenmeyen cagri: " + args.join(" "));
    });
    expect(logs.getServiceStatus("caddy")).toBe("inactive");
  });

  it("is-active bos donerse list-unit-files fallback'i ile inactive dogrulanir", () => {
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (args[0] === "is-active") {
        const err = new Error("Command failed");
        err.stdout = Buffer.from("");
        err.stderr = Buffer.from("");
        throw err;
      }
      if (args[0] === "list-unit-files") {
        expect(args).toEqual(["list-unit-files", "cloudflared.service", "--no-legend"]);
        return Buffer.from("cloudflared.service enabled\n");
      }
      throw new Error("beklenmeyen cagri: " + args.join(" "));
    });
    expect(logs.getServiceStatus("cloudflared")).toBe("inactive");
  });

  it("systemctl stderr'inde 'could not be found' varsa null doner", () => {
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (args[0] === "is-active") {
        const err = new Error("Command failed");
        err.stdout = Buffer.from("");
        err.stderr = Buffer.from("Unit olmayan-servis.service could not be found.\n");
        throw err;
      }
      throw new Error("beklenmeyen cagri: " + args.join(" "));
    });
    expect(logs.getServiceStatus("olmayan-servis")).toBe(null);
    // not-found erkenden kesinlestigi icin list-unit-files hic cagrilmamali
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("systemctl stderr'inde 'not-found' varsa null doner", () => {
    execFileSyncMock.mockImplementation((cmd, args) => {
      if (args[0] === "is-active") {
        const err = new Error("Command failed");
        err.stdout = Buffer.from("");
        err.stderr = Buffer.from("Failed to get properties: unit not-found\n");
        throw err;
      }
      throw new Error("beklenmeyen cagri: " + args.join(" "));
    });
    expect(logs.getServiceStatus("hayali")).toBe(null);
  });
});
