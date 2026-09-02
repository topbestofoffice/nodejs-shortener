import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const verifier = resolve(projectRoot, "tools/verify-cloudways-package.mjs");
const packageFiles = [
  "deploy/cloudways/README.md",
  "deploy/cloudways/pilot.env.example",
  "deploy/cloudways/public_html.htaccess.example",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cloudways pilot package", () => {
  it("keeps the checked-in package bounded, placeholder-only and loopback-safe", () => {
    const result = runVerifier(projectRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Cloudways package verified: 3 files, 4 activation variables");
  });

  it.each([
    {
      name: "public Node bind",
      path: "deploy/cloudways/pilot.env.example",
      replace: ["HOST=127.0.0.1", "HOST=0.0.0.0"],
      error: "must keep HOST=127.0.0.1",
    },
    {
      name: "embedded database password",
      path: "deploy/cloudways/pilot.env.example",
      replace: ["MYSQL_PASSWORD=__PRIVATE_MYSQL_PASSWORD__", "MYSQL_PASSWORD=unsafe-example-password"],
      error: "must keep MYSQL_PASSWORD as a non-secret placeholder",
    },
    {
      name: "missing activation binding",
      path: "deploy/cloudways/pilot.env.example",
      replace: ["NODE_SHORTENER_DEPLOYMENT_TARGET_ID=__EXACT_CLOUDWAYS_DEPLOYMENT_TARGET_ID__\n", ""],
      error: "is missing NODE_SHORTENER_DEPLOYMENT_TARGET_ID",
    },
    {
      name: "proxy before uploads",
      path: "deploy/cloudways/public_html.htaccess.example",
      replace: [
        "RewriteRule ^uploads(?:/|$) - [END,NC]",
        "RewriteRule ^(.*)$ http://127.0.0.1:__UNIQUE_LOOPBACK_PORT__/$1 [P,END]\nRewriteRule ^uploads(?:/|$) - [END,NC]",
      ],
      error: "must contain exactly one proxy rule",
    },
    {
      name: "public origin-header injection",
      path: "deploy/cloudways/public_html.htaccess.example",
      replace: ["RewriteEngine On", "RewriteEngine On\nRequestHeader set X-Shortener-Origin-Auth unsafe"],
      error: "Vhost-only host/header directives must not be active",
    },
    {
      name: "unbound existing-file asset bypass",
      path: "deploy/cloudways/public_html.htaccess.example",
      replace: [
        "# Everything else, including manifest-bound UI assets, goes only to this",
        "RewriteCond %{REQUEST_FILENAME} -f\nRewriteRule ^ - [END]\n# Everything else, including manifest-bound UI assets, goes only to this",
      ],
      error: "Manifest-bound UI assets must not bypass Node",
    },
    {
      name: "missing nested dotfile denial",
      path: "deploy/cloudways/public_html.htaccess.example",
      replace: ["RewriteRule (?:^|/)\\. - [F,END,NC]\n", ""],
      error: "Nested dotfiles, sensitive files and executable uploads must be denied",
    },
    {
      name: "missing nested backup and config denial",
      path: "deploy/cloudways/public_html.htaccess.example",
      replace: [
        "RewriteRule (?:^|/)[^/]*\\.(?:env|ini|log|sql|bak|old|orig|save|tmp|swp|conf|config|key|pem|p12|pfx)(?:/|$) - [F,END,NC]\n",
        "",
      ],
      error: "Nested dotfiles, sensitive files and executable uploads must be denied",
    },
  ])("rejects $name", async ({ path, replace, error }) => {
    const root = await copiedPackage();
    const target = join(root, ...path.split("/"));
    const original = await readFile(target, "utf8");
    const search = replace[0] ?? "";
    const replacement = replace[1] ?? "";
    expect(original).toContain(search);
    await writeFile(target, original.replace(search, replacement), "utf8");

    const result = runVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});

async function copiedPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-cloudways-package-"));
  temporaryRoots.push(root);
  for (const path of packageFiles) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(projectRoot, path), target);
  }
  return root;
}

function runVerifier(root: string): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [verifier, `--root=${root}`], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}
