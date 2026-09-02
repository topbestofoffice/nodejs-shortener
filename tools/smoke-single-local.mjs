import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import sharp from "sharp";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "node-shortener-single-smoke-"));
const port = await reservePort();
const username = `single_${randomBytes(5).toString("hex")}`;
const password = `local-${randomBytes(16).toString("hex")}`;
const domainFile = join(temporaryRoot, "domains.json");
const privateTempDir = join(temporaryRoot, "private");
const publicUploadDir = join(temporaryRoot, "public");

await writeFile(domainFile, JSON.stringify([{
  id: 1,
  key: "shortener",
  canonicalHost: "single.local",
  aliases: ["www.single.local"],
  label: "Single Shortener",
  surface: "dashboard",
  active: true,
  allowCreate: true,
  publicBaseUrl: `http://single.local:${port}`,
  imageBaseUrl: `http://single.local:${port}`,
}], null, 2));

const child = spawn(process.execPath, [join(projectRoot, "dist", "server.js")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    APP_NAMESPACE: "node-shortener-single-smoke",
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "info",
    DOMAIN_CONFIG_FILE: domainFile,
    TRUST_PROXY: "false",
    TRUST_CLOUDFLARE_HEADERS: "false",
    PROXY_CHAIN_VERIFIED: "false",
    ORIGIN_AUTH_ENABLED: "false",
    STORAGE_DRIVER: "memory",
    IMAGE_EXECUTOR: "inline",
    PRIVATE_TEMP_DIR: privateTempDir,
    PUBLIC_UPLOAD_DIR: publicUploadDir,
    SERVE_STATIC_UPLOADS: "true",
    DEV_SEED_USERNAME: username,
    DEV_SEED_PASSWORD: password,
    REDIRECT_ENGINE: "passthrough",
    PILOT_HEADER_DIAGNOSTICS: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let processOutput = "";
child.stdout.on("data", (chunk) => { processOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { processOutput += chunk.toString(); });

const checks = [];
try {
  await waitUntilReady(port, child, () => processOutput);

  const ready = await request(port, "single.local", "/health/ready");
  assert(ready.status === 200 && (await ready.json()).domain_id === 1, "Single-domain readiness failed");
  checks.push("single_domain_ready");

  const unknown = await request(port, "vidx1x.local", "/health/ready");
  assert(unknown.status === 421, "Unconfigured multi-domain Host was accepted");
  checks.push("single_domain_host_boundary");

  const publicHome = await request(port, "single.local", "/");
  const publicHtml = await publicHome.text();
  assert(publicHome.status === 200 && publicHtml.includes('action="/auth/login"'), "Single-domain public login shell failed");
  checks.push("single_domain_public_shell");

  const preAuth = await request(port, "single.local", "/auth/csrf");
  const preAuthBody = await preAuth.json();
  const preAuthCookie = cookieHeader(preAuth);
  const login = await request(port, "single.local", "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: preAuthCookie },
    body: new URLSearchParams({ username, password, csrf: preAuthBody.csrf }),
  });
  const loginBody = await login.json();
  const cookie = cookieHeader(login);
  assert(login.status === 200 && loginBody.ok === true && cookie.includes("node_shortener_session="), "Single-domain login failed");
  checks.push("single_domain_login");

  const authenticatedHome = await request(port, "single.local", "/", { headers: { cookie } });
  const authenticatedHtml = await authenticatedHome.text();
  assert(authenticatedHome.status === 200
    && authenticatedHtml.includes(`Signed in as <strong>${username}</strong>`)
    && authenticatedHtml.includes("Account history"), "Single-domain authenticated dashboard failed");
  checks.push("single_domain_authenticated_shell");

  const uploadForm = new FormData();
  uploadForm.set("csrf", loginBody.csrf);
  const sourceImage = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 21, g: 110, b: 83 } },
  }).png().toBuffer();
  uploadForm.set("image", new Blob([sourceImage], { type: "image/png" }), "single.png");
  const uploaded = await request(port, "single.local", "/upload.php", {
    method: "POST",
    headers: { cookie },
    body: uploadForm,
  });
  const uploadedBody = await uploaded.json();
  assert(uploaded.status === 200 && uploadedBody.ok === true
    && /^uploads\/[0-9a-f]{16}\.jpg$/.test(uploadedBody.path), "Single-domain image upload failed");
  assert((await stat(join(publicUploadDir, basename(uploadedBody.path)))).isFile(), "Single-domain image file is missing");
  checks.push("single_domain_image_upload");

  const destination = "https://example.com/single-domain-smoke";
  const form = new FormData();
  form.set("csrf", loginBody.csrf);
  form.set("action", "create_single");
  form.set("domain_id", "1");
  form.set("destination", destination);
  form.set("image_url", uploadedBody.path);
  const created = await request(port, "single.local", "/api.php", { method: "POST", headers: { cookie }, body: form });
  const createdBody = await created.json();
  assert(created.status === 200 && createdBody.ok === true, "Single-domain creation failed");
  const shortUrl = new URL(createdBody.short);
  assert(shortUrl.hostname === "single.local", "Single-domain link used another Host");
  const redirected = await request(port, "single.local", shortUrl.pathname, {
    headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
    redirect: "manual",
  });
  assert(redirected.status === 301 && redirected.headers.get("location") === destination, "Single-domain redirect failed");
  checks.push("single_domain_create_and_redirect");

  const slashRedirect = await request(port, "single.local", `${shortUrl.pathname}/`, {
    headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
    redirect: "manual",
  });
  assert(slashRedirect.status === redirected.status && slashRedirect.headers.get("location") === destination,
    "Single-domain trailing-slash redirect changed behavior");
  checks.push("single_domain_trailing_slash");

  const history = await request(port, "single.local", "/index.php", { headers: { cookie } });
  const historyHtml = await history.text();
  assert(history.status === 200 && historyHtml.includes(shortUrl.pathname.slice(1))
    && historyHtml.includes(destination), "Single-domain history did not reload the committed link");
  checks.push("single_domain_persisted_history");

  const alias = await request(port, "www.single.local", `${shortUrl.pathname}?source=alias`, { redirect: "manual" });
  assert(alias.status === 301, "Single-domain alias was not canonicalized");
  assert(alias.headers.get("location") === `http://single.local:${port}${shortUrl.pathname}?source=alias`, "Single-domain alias changed the path/query");
  checks.push("single_domain_alias_canonicalization");

  const deleteForm = new FormData();
  deleteForm.set("csrf", loginBody.csrf);
  deleteForm.set("action", "delete");
  deleteForm.set("domain_id", "1");
  deleteForm.set("code", shortUrl.pathname.slice(1));
  const deleted = await request(port, "single.local", "/api.php", {
    method: "POST",
    headers: { cookie },
    body: deleteForm,
  });
  assert(deleted.status === 200 && (await deleted.json()).ok === true, "Single-domain owner delete failed");
  assert((await request(port, "single.local", shortUrl.pathname, { redirect: "manual" })).status === 404,
    "Deleted single-domain link still resolved");
  checks.push("single_domain_owner_delete");

  const logout = await request(port, "single.local", "/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf: loginBody.csrf }),
  });
  assert(logout.status === 200 && (await logout.json()).ok === true, "Single-domain logout failed");
  const loggedOutHome = await request(port, "single.local", "/", { headers: { cookie } });
  const loggedOutHtml = await loggedOutHome.text();
  assert(loggedOutHtml.includes('id="loginForm"') && !loggedOutHtml.includes("Account history"),
    "Single-domain revoked session still opened history");
  checks.push("single_domain_logout_revocation");

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  if (processOutput.trim() !== "") process.stderr.write(`server output:\n${processOutput.slice(-4_000)}\n`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await removeOwnedTemporaryDirectory(temporaryRoot);
}

function cookieHeader(response) {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

async function request(portNumber, host, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("host", host);
  const body = await serializeBody(options.body, headers);
  if (body !== null) headers.set("content-length", String(body.length));
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port: portNumber,
      path,
      method: options.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const payload = Buffer.concat(chunks).toString("utf8");
        resolveRequest({
          status: incoming.statusCode ?? 0,
          headers: {
            get(name) {
              const value = incoming.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : value ?? null;
            },
            getSetCookie() {
              const value = incoming.headers["set-cookie"];
              return Array.isArray(value) ? value : value === undefined ? [] : [value];
            },
          },
          async json() { return JSON.parse(payload); },
          async text() { return payload; },
        });
      });
    });
    outgoing.once("error", rejectRequest);
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

async function serializeBody(body, headers) {
  if (body === undefined || body === null) return null;
  if (body instanceof FormData) {
    const encoded = new Response(body);
    const contentType = encoded.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
    return Buffer.from(await encoded.arrayBuffer());
  }
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (typeof body === "string" || Buffer.isBuffer(body)) return Buffer.from(body);
  throw new TypeError("Unsupported smoke-test request body");
}

async function waitUntilReady(portNumber, spawned, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawned.exitCode !== null) throw new Error(`Local server exited before readiness. ${output().slice(-1_000)}`);
    try {
      const response = await request(portNumber, "single.local", "/health/live");
      if (response.status === 200) return;
    } catch {
      // Listener not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Single-domain server did not become ready within 20 seconds");
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a local port"));
        return;
      }
      const selected = address.port;
      server.close((error) => error === undefined ? resolvePort(selected) : rejectPort(error));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function removeOwnedTemporaryDirectory(path) {
  const resolved = resolve(path);
  const temporaryBase = `${resolve(tmpdir())}${sep}`;
  if (!resolved.startsWith(temporaryBase) || !basename(resolved).startsWith("node-shortener-single-smoke-")) {
    throw new Error("Refusing to remove a directory outside the owned single-domain smoke-test path");
  }
  await rm(resolved, { recursive: true, force: true });
}
