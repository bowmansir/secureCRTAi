import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfigText = readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");
const tauriConfig = JSON.parse(tauriConfigText);
const cargoToml = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const desktopUpdateRust = readFileSync(
  new URL("../src-tauri/src/desktop_update.rs", import.meta.url),
  "utf8"
);
const capability = JSON.parse(
  readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8")
);

test("package, Cargo and Tauri use one release version", () => {
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(cargoVersion, packageJson.version);
  assert.equal(tauriConfig.version, packageJson.version);
});

test("Mya updater configuration uses the Termexa identity and signed artifacts", () => {
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(tauriConfig.bundle.publisher, "Mya");
  assert.match(tauriConfig.plugins.updater.pubkey, /^[A-Za-z0-9+/=]{100,}$/);
  assert.deepEqual(tauriConfig.plugins.updater.endpoints, [
    "https://update-task.bowsu.com/api/desktop-update/termexa/{{target}}/{{arch}}/{{current_version}}?channel=stable",
  ]);
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:allow-restart"));
});

test("client release configuration contains no signing private key", () => {
  const inspected = `${tauriConfigText}\n${cargoToml}\n${desktopUpdateRust}`;
  assert.doesNotMatch(inspected, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
  assert.doesNotMatch(inspected, /TAURI_SIGNING_PRIVATE_KEY\s*=/);
});

test("production probe uses the deployed RSA-3072 public key identity", () => {
  assert.match(desktopUpdateRust, /PROBE_KEY_ID: &str = "desktop-probe-2026-07"/);
  const publicKey = desktopUpdateRust.match(
    /PROBE_PUBLIC_KEY_DER_BASE64: &str = "([A-Za-z0-9+/=]+)"/
  )?.[1];
  assert.ok(publicKey);
  assert.ok(Buffer.from(publicKey, "base64").length >= 422);
});
