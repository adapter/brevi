import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateMacHostSupport,
  MAC_WORKER_REQUIREMENT,
  MIN_CHIP_GENERATION,
  MIN_MACOS_MAJOR,
  parseChipGeneration,
  parseMacosMajor,
  type MacHostFacts,
} from "../src/mac/preflight.js";
import { mayStopAfterReservation, nextSupervisorDecision, type SupervisorState } from "../src/mac/idle.js";
import {
  DEFAULT_MAC_VM_NAME,
  forgetMacVmSettings,
  loadMacVmSettings,
  normalizeMacVmSettings,
  saveMacVmSettings,
} from "../src/mac/state.js";
import {
  assertValidLimaInstanceName,
  guestHostUrl,
  guestTapCount,
  GUEST_IMAGE,
  GUEST_NETWORK_SCRIPT_PATH,
  GUEST_NETWORK_SERVICE_NAME,
  GUEST_SERVICE_NAME,
  isUsableHostUrl,
  LIMA_HOST_GATEWAY,
  renderGuestConfig,
  renderGuestNetworkScript,
  renderGuestNetworkService,
  renderGuestService,
  renderLimaTemplate,
  renderProvisionScript,
  sameHostOrigin,
  type GuestOptions,
  type TemplateOptions,
} from "../src/mac/template.js";

// Run with `bun test packages/cli` from the repo root. This covers the pure,
// side-effect-free modules under src/mac/ (hardware preflight, VM settings,
// the Lima/systemd/shell templates, and the idle-stop supervisor); none of it
// spawns limactl or launchctl, so it runs the same on Linux CI as on a Mac.

describe("evaluateMacHostSupport", () => {
  const m3: MacHostFacts = { platform: "darwin", cpuBrand: "Apple M3 Pro", productVersion: "15.3.1" };

  it("supports an M3 Mac on macOS 15", () => {
    const result = evaluateMacHostSupport(m3);
    expect(result.supported).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.chipGeneration).toBe(3);
    expect(result.macosMajor).toBe(15);
  });

  it("refuses an M1 Mac, naming the chip generation requirement", () => {
    const result = evaluateMacHostSupport({ ...m3, cpuBrand: "Apple M1" });
    expect(result.supported).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toBe(
      "This Mac has an Apple M1 chip; nested virtualization requires M3 or newer.",
    );
  });

  it("refuses an M2 Mac the same way", () => {
    const result = evaluateMacHostSupport({ ...m3, cpuBrand: "Apple M2 Max" });
    expect(result.supported).toBe(false);
    expect(result.problems[0]).toContain("Apple M2 chip");
  });

  it("refuses an Intel Mac, naming Apple silicon as the requirement", () => {
    const result = evaluateMacHostSupport({
      ...m3,
      cpuBrand: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
    });
    expect(result.supported).toBe(false);
    expect(result.problems).toEqual([
      "This Mac has an Intel processor; the brevi macOS worker requires Apple silicon (M3 or newer).",
    ]);
  });

  it("says the processor is unknown, not Intel, when the sysctl probe came back empty", () => {
    const result = evaluateMacHostSupport({ ...m3, cpuBrand: "" });
    expect(result.supported).toBe(false);
    expect(result.problems).toEqual([
      "This Mac's processor could not be determined; the brevi macOS worker requires Apple silicon (M3 or newer).",
    ]);
  });

  it("refuses macOS 14, naming the OS version requirement", () => {
    const result = evaluateMacHostSupport({ ...m3, productVersion: "14.6" });
    expect(result.supported).toBe(false);
    expect(result.problems).toEqual([
      "This Mac runs macOS 14.6; the brevi macOS worker requires macOS 15 or newer.",
    ]);
  });

  it("refuses Linux outright, without pretending to know the chip or OS version", () => {
    const result = evaluateMacHostSupport({ platform: "linux", cpuBrand: "", productVersion: "" });
    expect(result.supported).toBe(false);
    expect(result.problems).toEqual([
      "This is a linux machine; the brevi macOS worker only runs on macOS.",
    ]);
    expect(result.chipGeneration).toBeUndefined();
    expect(result.macosMajor).toBeUndefined();
  });

  it("reports every unmet requirement when a machine fails more than one", () => {
    const result = evaluateMacHostSupport({
      platform: "darwin",
      cpuBrand: "Apple M1",
      productVersion: "14.6",
    });
    expect(result.supported).toBe(false);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain("Apple M1 chip");
    expect(result.problems[1]).toContain("macOS 14.6");
  });

  it("exposes the gate as constants the CLI text can reuse", () => {
    expect(MIN_CHIP_GENERATION).toBe(3);
    expect(MIN_MACOS_MAJOR).toBe(15);
    expect(MAC_WORKER_REQUIREMENT.length).toBeGreaterThan(0);
  });
});

describe("parseChipGeneration", () => {
  it("reads the generation out of an Apple chip brand string", () => {
    expect(parseChipGeneration("Apple M3 Pro")).toBe(3);
    expect(parseChipGeneration("Apple M4 Max")).toBe(4);
    expect(parseChipGeneration("Apple M10")).toBe(10);
  });

  it("returns undefined for Intel or an unreadable brand string", () => {
    expect(parseChipGeneration("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz")).toBeUndefined();
    expect(parseChipGeneration("")).toBeUndefined();
  });
});

describe("parseMacosMajor", () => {
  it("reads the major version out of a productVersion string", () => {
    expect(parseMacosMajor("15.3.1")).toBe(15);
    expect(parseMacosMajor("26.0")).toBe(26);
  });

  it("returns undefined when it cannot parse", () => {
    expect(parseMacosMajor("")).toBeUndefined();
  });
});

describe("normalizeMacVmSettings", () => {
  it("fills in every default from an empty object", () => {
    const settings = normalizeMacVmSettings({});
    expect(settings).toEqual({
      name: DEFAULT_MAC_VM_NAME,
      cpus: 4,
      memoryGiB: 8,
      diskGiB: 100,
      idleStopMinutes: 20,
      pollSeconds: 20,
      hostUrl: "",
      token: "",
      workerName: "",
      workerId: "",
      credential: "",
      selfDrained: false,
      concurrency: 1,
    });
  });

  it("keeps a persisted shutdown reservation, and ignores a non-boolean one", () => {
    // The flag has to survive a supervisor restart: it is the only record that
    // the drain on the host is this supervisor's to lift rather than an
    // operator's to keep.
    expect(normalizeMacVmSettings({ selfDrained: true }).selfDrained).toBe(true);
    expect(normalizeMacVmSettings({ selfDrained: "yes" }).selfDrained).toBe(false);
  });

  it("clamps out-of-range numbers into their allowed bounds", () => {
    const settings = normalizeMacVmSettings({
      cpus: 0,
      memoryGiB: 100_000,
      diskGiB: 1,
      idleStopMinutes: -5,
      pollSeconds: 1,
      concurrency: 9999,
    });
    expect(settings.cpus).toBe(1);
    expect(settings.memoryGiB).toBe(512);
    expect(settings.diskGiB).toBe(20);
    expect(settings.idleStopMinutes).toBe(0);
    expect(settings.pollSeconds).toBe(5);
    expect(settings.concurrency).toBeLessThanOrEqual(16);
  });

  it("ignores garbage types and falls back to the default", () => {
    const settings = normalizeMacVmSettings({
      cpus: "four",
      memoryGiB: null,
      diskGiB: {},
      name: 42,
      hostUrl: [],
    });
    expect(settings.cpus).toBe(4);
    expect(settings.memoryGiB).toBe(8);
    expect(settings.diskGiB).toBe(100);
    expect(settings.name).toBe(DEFAULT_MAC_VM_NAME);
    expect(settings.hostUrl).toBe("");
  });

  it("lets overrides win, while ignoring undefined override fields", () => {
    const settings = normalizeMacVmSettings(
      { cpus: 8, hostUrl: "http://old:4400" },
      { cpus: 16, hostUrl: undefined, token: "new-token" },
    );
    expect(settings.cpus).toBe(16);
    expect(settings.hostUrl).toBe("http://old:4400");
    expect(settings.token).toBe("new-token");
  });
});

const guestOptions: GuestOptions = {
  hostUrl: "http://192.168.1.10:4400",
  token: "pairing-token",
  workerName: "mac-mini",
  concurrency: 2,
  cliVersion: "0.5.0",
};

const templateOptions: TemplateOptions = {
  ...guestOptions,
  cpus: 4,
  memoryGiB: 8,
  diskGiB: 100,
};

describe("renderGuestConfig", () => {
  it("selects the firecracker provider and carries the worker's concurrency, nothing else", () => {
    const config = JSON.parse(renderGuestConfig(guestOptions));
    expect(config).toEqual({ sandbox: { provider: "firecracker", concurrency: 2 } });
  });
});

describe("guestHostUrl", () => {
  it("rewrites every spelling of this machine to Lima's host gateway", () => {
    // Inside the guest each of these names the guest itself, so a worker
    // handed one would dial itself and never reach the orchestrator.
    expect(guestHostUrl("http://localhost:4400")).toBe(`http://${LIMA_HOST_GATEWAY}:4400`);
    expect(guestHostUrl("http://127.0.0.1:4410")).toBe(`http://${LIMA_HOST_GATEWAY}:4410`);
    expect(guestHostUrl("http://[::1]:4400")).toBe(`http://${LIMA_HOST_GATEWAY}:4400`);
    // A wildcard bind is how a host URL built straight off `server.host` reads.
    expect(guestHostUrl("http://0.0.0.0:4400")).toBe(`http://${LIMA_HOST_GATEWAY}:4400`);
  });

  it("leaves an address both sides already agree on untouched", () => {
    expect(guestHostUrl("http://192.168.1.10:4400")).toBe("http://192.168.1.10:4400");
    expect(guestHostUrl("https://brevi.example.com")).toBe("https://brevi.example.com");
    expect(guestHostUrl(`http://${LIMA_HOST_GATEWAY}:4400`)).toBe(`http://${LIMA_HOST_GATEWAY}:4400`);
  });

  it("keeps a path when there is one, and adds none when there isn't", () => {
    expect(guestHostUrl("http://localhost:4400/brevi")).toBe(`http://${LIMA_HOST_GATEWAY}:4400/brevi`);
    expect(guestHostUrl("http://localhost:4400")).not.toContain(":4400/");
  });

  it("passes through anything that is not a URL rather than throwing", () => {
    expect(guestHostUrl("")).toBe("");
    expect(guestHostUrl("not a url")).toBe("not a url");
  });
});

describe("saveMacVmSettings", () => {
  async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), "brevi-mac-state-"));
  }

  it("round-trips through the file, and leaves no temp file behind", async () => {
    const dir = await scratch();
    const path = join(dir, "mac-vm.json");
    const settings = normalizeMacVmSettings({}, { hostUrl: "http://host:4400", credential: "bwc_x", selfDrained: true });

    await saveMacVmSettings(settings, path);
    expect(await loadMacVmSettings(path)).toEqual(settings);
    // The temp file is the mechanism, not an artifact: a directory left
    // littered with credential-bearing .tmp files would be a leak of its own.
    expect(await readdir(dir)).toEqual(["mac-vm.json"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("writes mode 0600, even over a world-readable file that was there first", async () => {
    const dir = await scratch();
    const path = join(dir, "mac-vm.json");
    await writeFile(path, "{}\n", { mode: 0o644 });

    await saveMacVmSettings(normalizeMacVmSettings({}, { credential: "bwc_x" }), path);
    // The rename replaces the inode, so the new file's mode wins rather than
    // the old one's surviving underneath the write.
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await rm(dir, { recursive: true, force: true });
  });

  it("never leaves a half-written file where the previous one was", async () => {
    // A truncated file reads as no file at all, which would strand the
    // supervisor with no worker identity; rename is what makes that state
    // unreachable, so the replacement is observed to be all-or-nothing.
    const dir = await scratch();
    const path = join(dir, "mac-vm.json");
    const first = normalizeMacVmSettings({}, { credential: "first", workerId: "wk-1" });
    const second = normalizeMacVmSettings({}, { credential: "second", workerId: "wk-2" });

    await saveMacVmSettings(first, path);
    await saveMacVmSettings(second, path);

    const loaded = await loadMacVmSettings(path);
    expect(loaded?.credential).toBe("second");
    expect(loaded?.workerId).toBe("wk-2");

    await forgetMacVmSettings(path);
    expect(await loadMacVmSettings(path)).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("sameHostOrigin", () => {
  it("ignores a trailing slash and a path, the way the worker's own check does", () => {
    // This has to agree with `enrollmentFor` in @brevi/worker: it is the
    // comparison deciding whether the guest presents its stored credential at
    // all, so a disagreement would enroll a guest that then refuses to use
    // what it holds.
    expect(sameHostOrigin("http://host:4400", "http://host:4400/")).toBe(true);
    expect(sameHostOrigin("http://host:4400/", "http://host:4400")).toBe(true);
  });

  it("separates hosts that differ by name, port or scheme", () => {
    expect(sameHostOrigin("http://a:4400", "http://b:4400")).toBe(false);
    expect(sameHostOrigin("http://host:4400", "http://host:4410")).toBe(false);
    expect(sameHostOrigin("http://host:4400", "https://host:4400")).toBe(false);
  });

  it("falls back to an exact match for anything that is not a URL", () => {
    expect(sameHostOrigin("", "")).toBe(true);
    expect(sameHostOrigin("nonsense", "nonsense")).toBe(true);
    expect(sameHostOrigin("nonsense", "http://host:4400")).toBe(false);
  });
});

describe("isUsableHostUrl", () => {
  it("accepts an http(s) URL with a host", () => {
    expect(isUsableHostUrl("http://192.168.1.5:4400")).toBe(true);
    expect(isUsableHostUrl("https://brevi.example.com")).toBe(true);
    expect(isUsableHostUrl("http://localhost:4400")).toBe(true);
  });

  it("rejects what would leave the guest worker crash-looping under systemd", () => {
    expect(isUsableHostUrl("")).toBe(false);
    expect(isUsableHostUrl("not a url")).toBe(false);
    // The commonest typo: a host and port with no scheme at all. URL parses
    // this as protocol "192.168.1.5:", which is why the scheme is checked
    // rather than just the parse succeeding.
    expect(isUsableHostUrl("192.168.1.5:4400")).toBe(false);
    expect(isUsableHostUrl("ftp://192.168.1.5:4400")).toBe(false);
    expect(isUsableHostUrl("ws://192.168.1.5:4400")).toBe(false);
    expect(isUsableHostUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("guestTapCount", () => {
  it("keeps setup.ts's floor of 16, and rises with a higher concurrency", () => {
    expect(guestTapCount(1)).toBe(16);
    expect(guestTapCount(16)).toBe(16);
    expect(guestTapCount(24)).toBe(24);
  });
});

describe("renderGuestNetworkScript", () => {
  it("resolves the shipped script through the global npm root at run time, not install time", () => {
    const script = renderGuestNetworkScript(guestOptions);
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    // Resolved on each boot, so an upgraded @brevi/cli is picked up rather
    // than a path this one install happened to see being baked in.
    expect(script).toContain('script="$(npm root -g)/@brevi/cli/dist/scripts/setup-network.sh"');
    expect(script).toContain(`--taps ${guestTapCount(guestOptions.concurrency)}`);
    // The guest's worker unit runs as root, so the taps have to be owned by root.
    expect(script).toContain("--user root");
  });

  it("fails loudly rather than silently when the shipped script is gone", () => {
    expect(renderGuestNetworkScript(guestOptions)).toContain('if [ ! -f "$script" ]; then');
  });
});

describe("renderGuestNetworkService", () => {
  it("is a oneshot ordered ahead of the worker, and stays active for the boot", () => {
    const unit = renderGuestNetworkService();
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("RemainAfterExit=yes");
    expect(unit).toContain(`ExecStart=${GUEST_NETWORK_SCRIPT_PATH}`);
    expect(unit).toContain(`Before=${GUEST_SERVICE_NAME}.service`);
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("renderGuestService", () => {
  it("will not start before the networking unit has applied the rules", () => {
    // None of what `brevi setup` configures survives a reboot, and the
    // supervisor reboots this VM on every idle cycle, so a worker that came
    // up first would accept runs and fail each one on its first clone.
    const unit = renderGuestService(guestOptions);
    expect(unit).toContain(`Requires=${GUEST_NETWORK_SERVICE_NAME}.service`);
    expect(unit).toContain(`After=${GUEST_NETWORK_SERVICE_NAME}.service`);
  });

  it("tags the unit with BREVI_WORKER_OS=macos-vm and runs brevi worker with the given options", () => {
    const unit = renderGuestService(guestOptions);
    expect(unit).toContain("Environment=BREVI_WORKER_OS=macos-vm");
    // systemd needs an absolute path for the first token, and npm's global bin
    // is not at a fixed one, hence /usr/bin/env.
    expect(unit).toContain(`ExecStart=/usr/bin/env brevi worker --host "http://192.168.1.10:4400"`);
    expect(unit).toContain(`--token "pairing-token"`);
    expect(unit).toContain(`--name "mac-mini"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("User=root");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("quotes an awkward token the way systemd unescapes it, not the way a shell would", () => {
    // A single quote is literal inside systemd's double quotes, so it needs no
    // escaping; a double quote and a backslash do, and % would otherwise be
    // read as the start of a specifier.
    const unit = renderGuestService({ ...guestOptions, token: `it's "a\\token" 100%` });
    // The whole line, so a token that broke out of its word would show up as a
    // changed argument list rather than a still-passing substring match.
    expect(unit.match(/ExecStart=.*/)?.[0]).toBe(
      `ExecStart=/usr/bin/env brevi worker --host "http://192.168.1.10:4400" --token "it's \\"a\\\\token\\" 100%%" --name "mac-mini"`,
    );
  });

  it("gives the guest a host URL that resolves inside the VM, not the Mac's own loopback", () => {
    // The settings hold the Mac's view of the host, which is what the
    // supervisor out there polls; only the guest's copy is translated.
    const unit = renderGuestService({ ...guestOptions, hostUrl: "http://localhost:4410" });
    expect(unit.match(/ExecStart=.*/)?.[0]).toBe(
      `ExecStart=/usr/bin/env brevi worker --host "http://${LIMA_HOST_GATEWAY}:4410" --token "pairing-token" --name "mac-mini"`,
    );
  });

  it("omits --token entirely once the guest is enrolled, since a redeemed token is dead", () => {
    const unit = renderGuestService({ ...guestOptions, token: "" });
    expect(unit.match(/ExecStart=.*/)?.[0]).toBe(
      `ExecStart=/usr/bin/env brevi worker --host "http://192.168.1.10:4400" --name "mac-mini"`,
    );
  });

  it("refuses a value with a line break, which no quoting inside the unit could contain", () => {
    expect(() => renderGuestService({ ...guestOptions, workerName: "mac\nExecStart=/bin/sh" })).toThrow(
      /line break/,
    );
  });
});

describe("renderProvisionScript", () => {
  it("invokes brevi setup --yes and writes both config files at mode 600", () => {
    const script = renderProvisionScript(guestOptions);
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("brevi setup --yes");
    expect(script).toContain("chmod 600 /root/.brevi/config.json");
    expect(script).toContain(`chmod 600 /etc/systemd/system/${GUEST_SERVICE_NAME}.service`);
    expect(script).toContain(`npm install -g "@brevi/cli@${guestOptions.cliVersion}"`);
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain(`systemctl enable ${GUEST_SERVICE_NAME}`);
    // A re-run has the service already up, so only a restart applies a changed
    // host, token or worker name.
    expect(script).toContain(`systemctl restart ${GUEST_SERVICE_NAME}`);
  });

  it("does not let npm list's non-zero exit abort provisioning under set -e", () => {
    expect(renderProvisionScript(guestOptions)).toContain("|| true)\"");
  });

  it("embeds the rendered guest config and service unit verbatim", () => {
    const script = renderProvisionScript(guestOptions);
    expect(script).toContain(renderGuestConfig(guestOptions));
    expect(script).toContain(renderGuestService(guestOptions));
  });

  it("installs the boot-time networking unit, enabled and started before the worker", () => {
    const script = renderProvisionScript(guestOptions);
    expect(script).toContain(renderGuestNetworkScript(guestOptions));
    expect(script).toContain(renderGuestNetworkService());
    // Executable, unlike the units: systemd runs it directly.
    expect(script).toContain(`chmod 755 ${GUEST_NETWORK_SCRIPT_PATH}`);
    expect(script).toContain(`chmod 644 /etc/systemd/system/${GUEST_NETWORK_SERVICE_NAME}.service`);
    expect(script).toContain(`systemctl enable ${GUEST_NETWORK_SERVICE_NAME}`);

    // Ordering is the point of the whole unit: the networking has to be
    // enabled and restarted ahead of the worker in the script too, not just
    // declared in the unit files.
    expect(script.indexOf(`systemctl enable ${GUEST_NETWORK_SERVICE_NAME}\n`)).toBeLessThan(
      script.indexOf(`systemctl enable ${GUEST_SERVICE_NAME}\n`),
    );
    expect(script.indexOf(`systemctl restart ${GUEST_NETWORK_SERVICE_NAME}\n`)).toBeLessThan(
      script.indexOf(`systemctl restart ${GUEST_SERVICE_NAME}\n`),
    );
  });
});

describe("renderLimaTemplate", () => {
  it("turns on nested virtualization with vz, pins the image digest, and mounts nothing", () => {
    const yaml = renderLimaTemplate(templateOptions);
    expect(yaml).toContain('vmType: "vz"');
    expect(yaml).toContain("nestedVirtualization: true");
    expect(yaml).toContain(`digest: "${GUEST_IMAGE.digest}"`);
    expect(yaml).toContain("mounts: []");
    expect(yaml).toContain(`cpus: ${templateOptions.cpus}`);
    expect(yaml).toContain(`memory: "${templateOptions.memoryGiB}GiB"`);
    expect(yaml).toContain(`disk: "${templateOptions.diskGiB}GiB"`);
  });

  it("says the file is generated and hand edits are overwritten", () => {
    const yaml = renderLimaTemplate(templateOptions);
    expect(yaml).toMatch(/generated by `brevi mac install`/i);
    expect(yaml).toMatch(/overwritten/i);
  });

  it("indents every line of the provisioning script consistently under the block scalar", () => {
    const yaml = renderLimaTemplate(templateOptions);
    const lines = yaml.split("\n");
    const scriptStart = lines.findIndex((line) => line.trim() === "script: |");
    expect(scriptStart).toBeGreaterThan(-1);

    const script = renderProvisionScript(templateOptions);
    const scriptLineCount = script.split("\n").length;
    const inlined = lines.slice(scriptStart + 1, scriptStart + 1 + scriptLineCount);

    // Every inlined line (including blank ones) carries the same indent
    // prefix, and stripping it reproduces the script exactly.
    const indent = "      ";
    for (const line of inlined) {
      expect(line.startsWith(indent)).toBe(true);
    }
    expect(inlined.map((line) => line.slice(indent.length)).join("\n")).toBe(script);
  });

  it("throws on a Lima instance name outside [a-z0-9-]+", () => {
    expect(() => assertValidLimaInstanceName("Not Valid!")).toThrow();
    expect(() => assertValidLimaInstanceName("brevi_mac")).toThrow();
    expect(() => assertValidLimaInstanceName("brevi-mac-2")).not.toThrow();
  });
});

describe("nextSupervisorDecision", () => {
  const idleStopMinutes = 20;
  const baseTick = { nowMs: 0, vmRunning: true, idleStopMinutes };

  it("does nothing and preserves state when the host is unreachable", () => {
    const state: SupervisorState = { idleSinceMs: 100 };
    const decision = nextSupervisorDecision(state, { ...baseTick, demand: undefined });
    expect(decision.action).toBe("none");
    expect(decision.state).toEqual(state);
  });

  it("starts a stopped VM when runs are queued", () => {
    const decision = nextSupervisorDecision(
      {},
      {
        nowMs: 0,
        vmRunning: false,
        idleStopMinutes,
        demand: { queuedRuns: 1, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(decision.action).toBe("start");
  });

  it("leaves a stopped VM stopped when nothing is queued", () => {
    const decision = nextSupervisorDecision(
      {},
      {
        nowMs: 0,
        vmRunning: false,
        idleStopMinutes,
        demand: { queuedRuns: 0, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(decision.action).toBe("none");
  });

  it("does nothing while the VM is busy with an active run, and clears the idle timer", () => {
    const decision = nextSupervisorDecision(
      { idleSinceMs: 10 },
      {
        ...baseTick,
        nowMs: 1000,
        demand: { queuedRuns: 0, workerConnected: true, workerActiveRuns: 1, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(decision.action).toBe("none");
    expect(decision.state.idleSinceMs).toBeUndefined();
  });

  it("also counts an attach session or queued host work as busy", () => {
    const attach = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        demand: { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 1, workerEligible: true },
      },
    );
    expect(attach.action).toBe("none");
    expect(attach.state.idleSinceMs).toBeUndefined();

    const queued = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        demand: { queuedRuns: 3, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(queued.action).toBe("none");
    expect(queued.state.idleSinceMs).toBeUndefined();
  });

  it("leaves a drained worker's VM stopped however long the host's queue is", () => {
    // The scheduler never dispatches to a draining worker, so those runs are
    // not this machine's to take: booting for them would leave a VM awake and
    // idle until someone re-enables it.
    const decision = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        vmRunning: false,
        demand: { queuedRuns: 5, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: false },
      },
    );
    expect(decision.action).toBe("none");
    expect(decision.reason).toContain("drained");
  });

  it("lets a drained worker's VM go idle and stop, rather than being held awake by the queue", () => {
    const drainedIdle = {
      queuedRuns: 5,
      workerConnected: true,
      workerActiveRuns: 0,
      workerAttachSessions: 0,
      workerEligible: false,
    };
    const first = nextSupervisorDecision({}, { ...baseTick, nowMs: 0, demand: drainedIdle });
    expect(first.action).toBe("none");
    expect(first.state.idleSinceMs).toBe(0);

    const stop = nextSupervisorDecision(first.state, {
      ...baseTick,
      nowMs: idleStopMinutes * 60_000,
      demand: drainedIdle,
    });
    expect(stop.action).toBe("stop");
  });

  it("keeps a drained worker awake while it finishes what it already holds", () => {
    // Draining means "accept nothing new", not "abandon what you hold": a run
    // in flight and an open attach session both still count as busy.
    const draining = { queuedRuns: 0, workerConnected: true, workerAttachSessions: 0, workerEligible: false };
    const running = nextSupervisorDecision(
      { idleSinceMs: 0 },
      { ...baseTick, nowMs: idleStopMinutes * 60_000, demand: { ...draining, workerActiveRuns: 1 } },
    );
    expect(running.action).toBe("none");
    expect(running.state.idleSinceMs).toBeUndefined();

    const attached = nextSupervisorDecision(
      { idleSinceMs: 0 },
      {
        ...baseTick,
        nowMs: idleStopMinutes * 60_000,
        demand: { ...draining, workerActiveRuns: 0, workerAttachSessions: 1 },
      },
    );
    expect(attached.action).toBe("none");
  });

  it("still starts for queued work once the worker is active again", () => {
    const decision = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        vmRunning: false,
        demand: { queuedRuns: 5, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(decision.action).toBe("start");
  });

  it("does not stop after reserving when anything is still in flight", () => {
    // The gate that closes the dispatch race: by the time the host answers the
    // drain it has already stopped placing runs here, so whatever it still
    // reports in flight is everything the shutdown would destroy.
    const reserved = { queuedRuns: 0, workerConnected: true, workerEligible: false };
    expect(
      mayStopAfterReservation({ ...reserved, workerActiveRuns: 0, workerAttachSessions: 0 }),
    ).toBe(true);
    expect(
      mayStopAfterReservation({ ...reserved, workerActiveRuns: 1, workerAttachSessions: 0 }),
    ).toBe(false);
    expect(
      mayStopAfterReservation({ ...reserved, workerActiveRuns: 0, workerAttachSessions: 1 }),
    ).toBe(false);
  });

  it("still stops after reserving when the only news is a queue it can no longer take", () => {
    // A run queued during the reservation is precisely what the shutdown is
    // getting out of the way of: drained, this worker will not be given it, so
    // it is not a reason to stay up.
    expect(
      mayStopAfterReservation({
        queuedRuns: 4,
        workerConnected: true,
        workerActiveRuns: 0,
        workerAttachSessions: 0,
        workerEligible: false,
      }),
    ).toBe(true);
  });

  it("never stops the VM when auto-stop is disabled (idleStopMinutes 0)", () => {
    const idleDemand = { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true };
    const decision = nextSupervisorDecision(
      {},
      { nowMs: 10_000_000, vmRunning: true, idleStopMinutes: 0, demand: idleDemand },
    );
    expect(decision.action).toBe("none");
    expect(decision.state.idleSinceMs).toBeUndefined();
  });

  it("starts the idle timer on the first idle tick and carries it forward", () => {
    const idleDemand = { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true };
    const first = nextSupervisorDecision({}, { ...baseTick, nowMs: 1_000, demand: idleDemand });
    expect(first.action).toBe("none");
    expect(first.state.idleSinceMs).toBe(1_000);

    // Survives across ticks: the timer keeps the original idleSinceMs, not
    // the tick's current time, as long as the VM stays idle.
    const second = nextSupervisorDecision(first.state, {
      ...baseTick,
      nowMs: 1_000 + 5 * 60_000,
      demand: idleDemand,
    });
    expect(second.action).toBe("none");
    expect(second.state.idleSinceMs).toBe(1_000);
  });

  it("fires exactly at the idle-stop threshold, not a tick before", () => {
    const idleDemand = { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true };
    const idleSinceMs = 0;
    const thresholdMs = idleStopMinutes * 60_000;

    const before = nextSupervisorDecision(
      { idleSinceMs },
      { ...baseTick, nowMs: thresholdMs - 1, demand: idleDemand },
    );
    expect(before.action).toBe("none");

    const at = nextSupervisorDecision(
      { idleSinceMs },
      { ...baseTick, nowMs: thresholdMs, demand: idleDemand },
    );
    expect(at.action).toBe("stop");
    // Carried, not cleared: deciding to stop is not the same as having
    // stopped. See the retry test below for why that matters.
    expect(at.state.idleSinceMs).toBe(idleSinceMs);
  });

  it("retries the stop on the very next tick when limactl failed and the VM is still running", () => {
    const idleDemand = { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true };
    const idleSinceMs = 0;
    const thresholdMs = idleStopMinutes * 60_000;

    const first = nextSupervisorDecision(
      { idleSinceMs },
      { ...baseTick, nowMs: thresholdMs, demand: idleDemand },
    );
    expect(first.action).toBe("stop");

    // `limactl stop` failed, so vmRunning is still true one poll later. The
    // expired timer has to survive that: clearing it would open a fresh idle
    // window and delay the retry by a whole idleStopMinutes.
    const retry = nextSupervisorDecision(first.state, {
      ...baseTick,
      nowMs: thresholdMs + 20_000,
      demand: idleDemand,
    });
    expect(retry.action).toBe("stop");
    expect(retry.state.idleSinceMs).toBe(idleSinceMs);
  });

  it("drops the carried timer once the VM is actually stopped", () => {
    const idleDemand = { queuedRuns: 0, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true };
    const stopped = nextSupervisorDecision(
      { idleSinceMs: 0 },
      { ...baseTick, vmRunning: false, nowMs: idleStopMinutes * 60_000, demand: idleDemand },
    );
    expect(stopped.action).toBe("none");
    expect(stopped.state.idleSinceMs).toBeUndefined();
  });

  it("clears the idle timer the moment work reappears", () => {
    const idle = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        nowMs: 1_000,
        demand: { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(idle.state.idleSinceMs).toBe(1_000);

    const busyAgain = nextSupervisorDecision(idle.state, {
      ...baseTick,
      nowMs: 2_000,
      demand: { queuedRuns: 0, workerConnected: true, workerActiveRuns: 1, workerAttachSessions: 0, workerEligible: true },
    });
    expect(busyAgain.action).toBe("none");
    expect(busyAgain.state.idleSinceMs).toBeUndefined();

    // Idle again afterwards restarts the timer from the new tick, not the old one.
    const idleAgain = nextSupervisorDecision(busyAgain.state, {
      ...baseTick,
      nowMs: 3_000,
      demand: { queuedRuns: 0, workerConnected: true, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
    });
    expect(idleAgain.state.idleSinceMs).toBe(3_000);
  });

  it("treats a worker that has not registered yet as idle, not as unreachable", () => {
    const decision = nextSupervisorDecision(
      {},
      {
        ...baseTick,
        nowMs: 500,
        demand: { queuedRuns: 0, workerConnected: false, workerActiveRuns: 0, workerAttachSessions: 0, workerEligible: true },
      },
    );
    expect(decision.action).toBe("none");
    expect(decision.state.idleSinceMs).toBe(500);
  });
});
