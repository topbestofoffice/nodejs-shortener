import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pm2DeploymentConfigurationSha256,
  verifyInstalledCloudways,
} from "../tools/verify-cloudways-installed.mjs";
import { parseExactEnvironment } from "../tools/cloudways-rendered-env.mjs";
import { safePm2Inventory } from "../tools/safe-pm2-inventory.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed Cloudways preflight", () => {
  it("binds the rendered private env to the one exact installed proxy and production startup", async () => {
    const fixture = await installedFixture();
    const startup = vi.fn();

    const result = await verifyInstalledCloudways({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      htaccessFile: fixture.htaccessFile,
      loadRuntimeConfig: async () => fixture.runtimeConfig,
      assertProductionStartupAllowed: startup,
      productionRuntimeConfigurationSha256: () => "b".repeat(64),
      productionPm2DeploymentConfigurationSha256: () => fixture.pm2Sha256,
    });

    expect(startup).toHaveBeenCalledOnce();
    expect(result.activationSha256).toBe("d".repeat(64));
    expect(result.pm2DeploymentConfigurationSha256).toBe(fixture.pm2Sha256);
    expect(result.htaccessSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["WEB_INSTANCES=1", "WEB_INSTANCES=garbage", "WEB_INSTANCES must be an explicit whole number"],
    ["PORT=3107", "PORT=3108", "missing, reordered, or unexpected proxy/static directives"],
    ["APP_NAMESPACE=pilot-shortener", "APP_NAMESPACE=__UNRESOLVED__", "still contains a placeholder"],
  ])("fails closed for rendered/proxy drift", async (search, replacement, message) => {
    const fixture = await installedFixture();
    const source = await readFile(fixture.environmentFile, "utf8");
    await writeFile(fixture.environmentFile, source.replace(search, replacement), "utf8");
    if (process.platform !== "win32") await chmod(fixture.environmentFile, 0o600);

    await expect(verifyInstalledCloudways({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      htaccessFile: fixture.htaccessFile,
      loadRuntimeConfig: async () => fixture.runtimeConfig,
      assertProductionStartupAllowed: vi.fn(),
      productionRuntimeConfigurationSha256: () => "b".repeat(64),
      productionPm2DeploymentConfigurationSha256: () => fixture.pm2Sha256,
    })).rejects.toThrow(message);
  });

  it("does not expose a secret returned by runtime validation", async () => {
    const fixture = await installedFixture();
    const secret = "private-mysql-password-123456";
    let message = "";
    try {
      await verifyInstalledCloudways({
        projectRoot: fixture.root,
        environmentFile: fixture.environmentFile,
        htaccessFile: fixture.htaccessFile,
        loadRuntimeConfig: async () => { throw new Error(secret); },
        assertProductionStartupAllowed: vi.fn(),
        productionRuntimeConfigurationSha256: () => "b".repeat(64),
        productionPm2DeploymentConfigurationSha256: () => fixture.pm2Sha256,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).toContain("does not satisfy the production runtime contract");
  });

  it("refuses a cross-release --root override before loading another contract", () => {
    const tool = resolve(import.meta.dirname, "../tools/verify-cloudways-installed.mjs");
    const result = spawnSync(process.execPath, [tool, "--root=C:/different-release"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: verify-cloudways-installed.mjs");
  });

  it("rejects a Node release rooted anywhere under public_html", async () => {
    const fixture = await installedFixture({ releaseUnderPublic: true });
    await expect(verifyInstalledCloudways({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      htaccessFile: fixture.htaccessFile,
      loadRuntimeConfig: async () => fixture.runtimeConfig,
      assertProductionStartupAllowed: vi.fn(),
      productionRuntimeConfigurationSha256: () => "b".repeat(64),
      productionPm2DeploymentConfigurationSha256: () => fixture.pm2Sha256,
    })).rejects.toThrow("release root must remain outside public_html");
  });

  it.each([
    ["MYSQL_HOST=127.0.0.1", "MYSQL_HOST=db.remote.internal", "MYSQL_HOST must be exact loopback"],
    ["REDIS_URL=redis://127.0.0.1:6379", "REDIS_URL=redis://redis.remote.internal:6379", "REDIS_URL must use plaintext only on exact loopback"],
  ])("rejects unverified remote plaintext data transport", async (search, replacement, message) => {
    const fixture = await installedFixture();
    const source = await readFile(fixture.environmentFile, "utf8");
    await writeFile(fixture.environmentFile, source.replace(search, replacement), "utf8");
    if (process.platform !== "win32") await chmod(fixture.environmentFile, 0o600);
    await expect(verifyInstalledCloudways({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      htaccessFile: fixture.htaccessFile,
      loadRuntimeConfig: async () => fixture.runtimeConfig,
      assertProductionStartupAllowed: vi.fn(),
      productionRuntimeConfigurationSha256: () => "b".repeat(64),
      productionPm2DeploymentConfigurationSha256: () => fixture.pm2Sha256,
    })).rejects.toThrow(message);
  });
});

describe("secret-safe PM2 inventory", () => {
  it("fails closed when an asserted absent or current-online state is not true", async () => {
    const fixture = await installedFixture();
    const absent = await safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
      expect: "absent",
    });
    expect(absent.expectation).toBe("absent");
    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
      expect: "current-online",
    })).rejects.toThrow("asserted current-online state");

    const currentRows = [
      { name: "pilot-shortener-image-worker", pm_id: 1, pid: 1001, pm2_env: {
        ...fixture.environment,
        status: "online", pm_cwd: fixture.root,
        pm_exec_path: resolve(fixture.root, "dist/workers/image-worker.js"),
        exec_interpreter: process.execPath,
      } },
      { name: "pilot-shortener-web", pm_id: 2, pid: 1002, pm2_env: {
        ...fixture.environment,
        status: "online", pm_cwd: fixture.root, pm_exec_path: resolve(fixture.root, "dist/server.js"),
        exec_interpreter: process.execPath,
      } },
    ];
    await writeFakePm2(fixture.pm2Cli, currentRows);
    const online = await safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
      expect: "current-online",
    });
    expect(online.expectation).toBe("current-online");
    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
      expect: "absent",
    })).rejects.toThrow("asserted absent state");

    await writeFakePm2(fixture.pm2Cli, currentRows.map((row, index) => index === 0 ? row : ({
      ...row,
      pm2_env: { ...row.pm2_env, NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256: "e".repeat(64) },
    })));
    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
      expect: "current-online",
    })).rejects.toThrow("asserted current-online state");
  });

  it("captures raw pm2_env internally and emits only bounded identity/status fields", async () => {
    const fixture = await installedFixture();
    const secret = "cookie-signing-secret-that-must-never-print";
    const fakeCli = fixture.pm2Cli;
    await writeFile(fakeCli, [
      "if (process.argv[2] === '--version') { process.stdout.write('6.2.0\\n'); process.exit(0); }",
      "const rows = [",
      `  {name:'pilot-shortener-web',pm_id:2,pid:4321,pm2_env:{status:'online',pm_cwd:${JSON.stringify(fixture.root)},pm_exec_path:${JSON.stringify(resolve(fixture.root, "dist/server.js"))},COOKIE_SIGNING_SECRET:${JSON.stringify(secret)}}},`,
      `  {name:'another-app',pm_id:9,pid:9999,pm2_env:{status:'online',pm_cwd:'/other',MYSQL_PASSWORD:${JSON.stringify(secret)}}},`,
      "]; process.stdout.write(JSON.stringify(rows));",
    ].join("\n"));
    const inventory = await safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fakeCli,
    });
    expect(JSON.stringify(inventory)).not.toContain(secret);
    expect(inventory.totalProcessCount).toBe(2);
    expect(inventory.otherProcessCount).toBe(1);
    expect(inventory.expected[1]!.instances[0]!.cwdMatchesRelease).toBe(true);

    const cli = resolve(import.meta.dirname, "../tools/safe-pm2-inventory.mjs");
    const result = spawnSync(process.execPath, [
      cli,
      `--root=${fixture.root}`,
      `--env-file=${fixture.environmentFile}`,
      `--pm2-cli=${fakeCli}`,
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: safe-pm2-inventory.mjs");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);

    const unboundCli = resolve(fixture.privateRoot, "runtime/unbound-pm2-cli.js");
    await writeFakePm2(unboundCli, []);
    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: unboundCli,
    })).rejects.toThrow("activation-bound PM2_CLI_SCRIPT");
  });

  it("recognizes one prior release in the same stable daemon and rejects duplicate cutover processes", async () => {
    const fixture = await installedFixture();
    const oldRelease = resolve(fixture.privateRoot, "releases/release-old");
    await mkdir(resolve(oldRelease, "dist/workers"), { recursive: true });
    const fakeCli = fixture.pm2Cli;
    const rows = [
      { name: "pilot-shortener-image-worker", pm_id: 1, pid: 1001, pm2_env: {
        status: "online", pm_cwd: oldRelease, pm_exec_path: resolve(oldRelease, "dist/workers/image-worker.js"),
        exec_interpreter: process.execPath, NODE_BINARY: process.execPath,
      } },
      { name: "pilot-shortener-web", pm_id: 2, pid: 1002, pm2_env: {
        status: "online", pm_cwd: oldRelease, pm_exec_path: resolve(oldRelease, "dist/server.js"),
        exec_interpreter: process.execPath, NODE_BINARY: process.execPath,
      } },
    ];
    await writeFakePm2(fakeCli, rows);

    const inventory = await safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fakeCli,
      expect: "same-lineage-old-online",
    });
    expect(inventory.otherProcessCount).toBe(0);
    for (const process_ of inventory.expected) {
      expect(process_.countMatchesExpected).toBe(true);
      expect(process_.instances[0]!.belongsToApplicationLineage).toBe(true);
      expect(process_.instances[0]!.cwdMatchesRelease).toBe(false);
      expect(process_.instances[0]!.scriptMatchesRelease).toBe(false);
      expect(process_.instances[0]!.releaseClassification).toBe("same-lineage-old-release");
    }

    await writeFakePm2(fakeCli, [...rows, { ...rows[1], pm_id: 3, pid: 1003 }]);
    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fakeCli,
    })).rejects.toThrow("process count");
  });

  it("rejects a mixed old/new release inventory even when the web count matches", async () => {
    const fixture = await installedFixture();
    const source = await readFile(fixture.environmentFile, "utf8");
    await writeFile(fixture.environmentFile, source.replace("WEB_INSTANCES=1", "WEB_INSTANCES=2"));
    if (process.platform !== "win32") await chmod(fixture.environmentFile, 0o600);
    const oldRelease = resolve(fixture.privateRoot, "releases/release-old");
    await mkdir(resolve(oldRelease, "dist/workers"), { recursive: true });
    await writeFakePm2(fixture.pm2Cli, [
      { name: "pilot-shortener-image-worker", pm_id: 1, pid: 1001, pm2_env: {
        status: "online", pm_cwd: oldRelease, pm_exec_path: resolve(oldRelease, "dist/workers/image-worker.js"),
      } },
      { name: "pilot-shortener-web", pm_id: 2, pid: 1002, pm2_env: {
        status: "online", pm_cwd: oldRelease, pm_exec_path: resolve(oldRelease, "dist/server.js"),
      } },
      { name: "pilot-shortener-web", pm_id: 3, pid: 1003, pm2_env: {
        status: "online", pm_cwd: fixture.root, pm_exec_path: resolve(fixture.root, "dist/server.js"),
      } },
    ]);

    await expect(safePm2Inventory({
      projectRoot: fixture.root,
      environmentFile: fixture.environmentFile,
      pm2Cli: fixture.pm2Cli,
    })).rejects.toThrow("multiple application release roots");
  });
});

async function writeFakePm2(path: string, rows: unknown[]) {
  await writeFile(path, [
    "if (process.argv[2] === '--version') { process.stdout.write('6.2.0\\n'); process.exit(0); }",
    `process.stdout.write(${JSON.stringify(JSON.stringify(rows))});`,
  ].join("\n"));
}

async function installedFixture(options: { releaseUnderPublic?: boolean } = {}) {
  const container = await mkdtemp(join(tmpdir(), "node-shortener-installed-preflight-"));
  roots.push(container);
  const privateRoot = resolve(container, "app-private");
  const publicRoot = resolve(container, "public_html");
  const root = options.releaseUnderPublic
    ? resolve(publicRoot, "release")
    : resolve(privateRoot, "releases/release-a");
  const pm2Cli = resolve(privateRoot, "runtime/pm2-cli.js");
  await mkdir(root, { recursive: true });
  const [environmentTemplate, htaccessTemplate] = await Promise.all([
    readFile(resolve(import.meta.dirname, "../deploy/cloudways/pilot.env.example"), "utf8"),
    readFile(resolve(import.meta.dirname, "../deploy/cloudways/public_html.htaccess.example"), "utf8"),
  ]);
  const uploads = resolve(publicRoot, "uploads");
  const temporary = resolve(privateRoot, "tmp");
  const replacements = new Map<string, string>([
    ["__UNIQUE_APP_NAMESPACE__", "pilot-shortener"],
    ["__APP_PRIVATE_ROOT_ABSOLUTE_PATH__", privateRoot],
    ["__APP_RELEASE_ROOT_ABSOLUTE_PATH__", root],
    ["__ABSOLUTE_NODE_BINARY__", process.execPath],
    ["__ABSOLUTE_PM2_CLI_SCRIPT__", pm2Cli],
    ["__EXACT_PM2_VERSION__", "6.2.0"],
    ["__UNIQUE_LOOPBACK_PORT__", "3107"],
    ["__EXACT_DOMAIN_CONFIG_FILE__", "domains.pilot"],
    ["__EXACT_CLOUDWAYS_DEPLOYMENT_TARGET_ID__", "cloudways-pilot-123456"],
    ["private/activation/__EXACT_PILOT_ACTIVATION_FILE__.json", "private/activation/pilot.json"],
    ["__EXACT_64_HEX_ACTIVATION_SHA256__", "d".repeat(64)],
    ["__PRIVATE_ORIGIN_AUTH_SHA256__", "a".repeat(64)],
    ["__PRIVATE_MYSQL_HOST__", "127.0.0.1"],
    ["__PRIVATE_MYSQL_PORT__", "3306"],
    ["__UNIQUE_MYSQL_DATABASE__", "pilot_shortener"],
    ["__UNIQUE_MYSQL_USER__", "pilot_user"],
    ["__PRIVATE_MYSQL_PASSWORD__", "private-mysql-password-123456"],
    ["__PRIVATE_REDIS_URL__", "redis://127.0.0.1:6379"],
    ["__UNIQUE_REDIS_KEY_PREFIX__", "pilot-shortener"],
    ["__PRIVATE_32_PLUS_CHARACTER_IP_HASH_SECRET__", "i".repeat(40)],
    ["__PRIVATE_32_PLUS_CHARACTER_COOKIE_SIGNING_SECRET__", "c".repeat(40)],
    ["__UNIQUE_PM2_PROCESS_PREFIX__", "pilot-shortener"],
    ["__PRIVATE_PM2_HOME_ABSOLUTE_PATH__", resolve(privateRoot, "pm2")],
    ["__PRIVATE_HTML_TEMP_ABSOLUTE_PATH__", temporary],
    ["__PUBLIC_HTML_UPLOADS_ABSOLUTE_PATH__", uploads],
    ["__PRIVATE_DIAGNOSTIC_TOKEN_SHA256_WHEN_ENABLED__", ""],
  ]);
  let environmentSource = environmentTemplate;
  for (const [placeholder, value] of replacements) environmentSource = environmentSource.replaceAll(placeholder, value);
  const environmentFile = resolve(privateRoot, "config/pilot.env");
  const htaccessFile = resolve(publicRoot, ".htaccess");
  await Promise.all([
    writeProjectFile(root, "deploy/cloudways/pilot.env.example", environmentTemplate),
    writeProjectFile(root, "deploy/cloudways/public_html.htaccess.example", htaccessTemplate),
    mkdir(dirname(environmentFile), { recursive: true }).then(() => writeFile(environmentFile, environmentSource)),
    mkdir(dirname(htaccessFile), { recursive: true }).then(() => writeFile(
      htaccessFile,
      htaccessTemplate.replaceAll("__UNIQUE_LOOPBACK_PORT__", "3107"),
    )),
    mkdir(uploads, { recursive: true }),
    mkdir(temporary, { recursive: true }),
    mkdir(resolve(privateRoot, "pm2"), { recursive: true }),
    mkdir(dirname(pm2Cli), { recursive: true }).then(() => writeFile(
      pm2Cli,
      "if (process.argv[2] === '--version') process.stdout.write('6.2.0\\n'); else process.stdout.write('[]');\n",
    )),
  ]);
  if (process.platform !== "win32") {
    await chmod(environmentFile, 0o600);
    await chmod(htaccessFile, 0o644);
    await chmod(temporary, 0o700);
    await chmod(resolve(privateRoot, "pm2"), 0o700);
  }
  const environment = parseExactEnvironment(environmentSource);
  const pm2Sha256 = pm2DeploymentConfigurationSha256(environment);
  return {
    root,
    privateRoot,
    pm2Cli,
    environmentFile,
    htaccessFile,
    pm2Sha256,
    runtimeConfig: {},
    environment,
  };
}

async function writeProjectFile(root: string, path: string, contents: string | Buffer) {
  const target = resolve(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}
