import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import sharp from "sharp";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "node-shortener-smoke-"));
const port = await reservePort();
const username = `pilot_${randomBytes(5).toString("hex")}`;
const password = `local-${randomBytes(16).toString("hex")}`;
const domainFile = join(temporaryRoot, "domains.json");
const privateTempDir = join(temporaryRoot, "private");
const publicUploadDir = join(temporaryRoot, "public");

await writeFile(domainFile, JSON.stringify([
  {
    id: 1,
    key: "url6x",
    canonicalHost: "url6x.local",
    aliases: ["www.url6x.local"],
    label: "URL6X",
    surface: "dashboard",
    active: true,
    allowCreate: false,
    publicBaseUrl: `http://url6x.local:${port}`,
    imageBaseUrl: `http://url6x.local:${port}`,
  },
  {
    id: 2,
    key: "vidx1x",
    canonicalHost: "vidx1x.local",
    aliases: ["www.vidx1x.local"],
    label: "VIDX1X",
    surface: "redirect",
    active: true,
    allowCreate: true,
    publicBaseUrl: `http://vidx1x.local:${port}`,
    imageBaseUrl: `http://vidx1x.local:${port}`,
  },
  {
    id: 3,
    key: "plays9x",
    canonicalHost: "plays9x.local",
    aliases: [],
    label: "Plays9X",
    surface: "redirect",
    active: true,
    allowCreate: true,
    publicBaseUrl: `http://plays9x.local:${port}`,
    imageBaseUrl: `http://plays9x.local:${port}`,
  },
], null, 2));

const child = spawn(process.execPath, [join(projectRoot, "dist", "server.js")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    APP_NAMESPACE: "node-shortener-smoke",
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

  const url6Ready = await request(port, "url6x.local", "/health/ready");
  assert(url6Ready.status === 200, "URL6X readiness failed");
  assert((await url6Ready.json()).domain_id === 1, "URL6X domain identity changed");
  checks.push("url6x_ready");

  for (const host of ["vidx1x.local", "plays9x.local"]) {
    for (const path of ["/health/live", "/health/ready"]) {
      const hiddenHealth = await request(port, host, path);
      assert(hiddenHealth.status === 404 && (await hiddenHealth.text()) === "Not found.\n",
        `${host} exposed ${path}`);
    }
  }
  checks.push("redirect_health_routes_hidden");

  const unknown = await request(port, "unknown.local", "/health/ready");
  assert(unknown.status === 421, "Unknown Host did not fail with 421");
  checks.push("unknown_host_421");

  const redirectSurface = await request(port, "vidx1x.local", "/index.php");
  assert(redirectSurface.status === 404, "Redirect-only Host exposed the dashboard path");
  assert((await redirectSurface.text()) === "", "Redirect-only root was not empty");
  const playsSurface = await request(port, "plays9x.local", "/");
  assert(playsSurface.status === 404 && (await playsSurface.text()) === "", "Plays9X exposed a public shell");
  checks.push("redirect_surface_isolated");

  const aliasGuard = await request(port, "www.url6x.local", "//attacker.example/path", { redirect: "manual" });
  assert(aliasGuard.status === 301, "Alias was not canonicalized");
  const aliasLocation = aliasGuard.headers.get("location") ?? "";
  assert(aliasLocation === `http://url6x.local:${port}/attacker.example/path`, "Alias canonicalization allowed an external target");
  checks.push("alias_open_redirect_guard");

  const preAuth = await request(port, "url6x.local", "/auth/csrf");
  assert(preAuth.status === 200, "Pre-authentication CSRF bootstrap failed");
  const preAuthBody = await preAuth.json();
  const preAuthCookie = preAuth.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const login = await request(port, "url6x.local", "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: preAuthCookie },
    body: new URLSearchParams({ username, password, csrf: preAuthBody.csrf }),
  });
  assert(login.status === 200, "Local seeded login failed");
  const loginBody = await login.json();
  assert(loginBody.ok === true && typeof loginBody.csrf === "string", "Login response contract changed");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  assert(cookie.includes("node_shortener_session=") && cookie.includes("fs_remember="), "Auth cookies were not issued");
  checks.push("login_and_shared_session_cookies");

  const dashboard = await request(port, "url6x.local", "/", { headers: { cookie } });
  const dashboardHtml = await dashboard.text();
  assert(dashboard.status === 200 && dashboardHtml.includes(`Signed in as <strong>${username}</strong>`),
    "Authenticated dashboard shell failed");
  assert(dashboardHtml.includes("Account history"), "Authenticated dashboard omitted persisted history");
  assert(dashboard.headers.get("cache-control")?.includes("no-store") === true, "Dashboard was cacheable");
  checks.push("authenticated_dashboard_shell");

  const uploadForm = new FormData();
  uploadForm.set("csrf", loginBody.csrf);
  const smokePng = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 34, g: 89, b: 144 } },
  }).png().toBuffer();
  uploadForm.set("image", new Blob([
    smokePng,
  ], { type: "image/png" }), "pixel.png");
  const upload = await request(port, "url6x.local", "/upload.php", { method: "POST", headers: { cookie }, body: uploadForm });
  const uploadBody = await upload.json();
  assert(upload.status === 200 && uploadBody.ok === true, "Local streamed image upload failed");
  assert(/^uploads\/[0-9a-f]{16}\.jpg$/.test(uploadBody.path), "Upload returned an unsafe storage path");
  const uploadedFile = await stat(join(publicUploadDir, basename(uploadBody.path)));
  assert(uploadedFile.isFile() && uploadedFile.size > 0, "Published image file is missing or empty");
  const uploadedPublic = await request(port, "url6x.local", `/${uploadBody.path}`);
  assert(uploadedPublic.status === 200 && uploadedPublic.headers.get("content-type")?.includes("image/jpeg") === true,
    "Published image was not served as a static JPEG");
  checks.push("streamed_image_upload_and_atomic_publish");

  const d1Form = new FormData();
  d1Form.set("csrf", loginBody.csrf);
  d1Form.set("action", "create_single");
  d1Form.set("domain_id", "1");
  d1Form.set("destination", "https://example.com/paused");
  const d1 = await request(port, "url6x.local", "/api.php", { method: "POST", headers: { cookie }, body: d1Form });
  const d1Body = await d1.json();
  assert(d1.status === 400 && d1Body.ok === false, "Paused URL6X unexpectedly accepted creation");
  checks.push("url6x_creation_paused");

  const destination = "https://example.com/node-smoke";
  const d2Form = new FormData();
  d2Form.set("csrf", loginBody.csrf);
  d2Form.set("action", "create_single");
  d2Form.set("domain_id", "2");
  d2Form.set("destination", destination);
  d2Form.set("image_url", uploadBody.path);
  const d2 = await request(port, "url6x.local", "/api.php", { method: "POST", headers: { cookie }, body: d2Form });
  const d2Body = await d2.json();
  assert(d2.status === 200 && d2Body.ok === true, "VIDX link creation failed");
  const shortUrl = new URL(d2Body.short);
  const redirected = await request(port, "vidx1x.local", shortUrl.pathname, {
    headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
    redirect: "manual",
  });
  assert(redirected.status === 301 && redirected.headers.get("location") === destination, "Created VIDX link did not redirect");
  const redirectedWithSlash = await request(port, "vidx1x.local", `${shortUrl.pathname}/`, {
    headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
    redirect: "manual",
  });
  assert(redirectedWithSlash.status === redirected.status
    && redirectedWithSlash.headers.get("location") === destination,
  "Trailing-slash VIDX link changed behavior");
  checks.push("vidx_create_and_redirect");

  const d3Destination = "https://example.com/node-smoke-d3";
  const d3Form = new FormData();
  d3Form.set("csrf", loginBody.csrf);
  d3Form.set("action", "create_single");
  d3Form.set("domain_id", "3");
  d3Form.set("destination", d3Destination);
  const d3 = await request(port, "url6x.local", "/api.php", { method: "POST", headers: { cookie }, body: d3Form });
  const d3Body = await d3.json();
  assert(d3.status === 200 && d3Body.ok === true, "Plays9X link creation failed");
  const d3ShortUrl = new URL(d3Body.short);
  const d3Redirected = await request(port, "plays9x.local", d3ShortUrl.pathname, {
    headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
    redirect: "manual",
  });
  assert(d3Redirected.status === 301 && d3Redirected.headers.get("location") === d3Destination, "Created Plays9X link did not redirect");
  checks.push("plays9x_create_and_redirect");

  const history = await request(port, "url6x.local", "/index.php", { headers: { cookie } });
  const historyHtml = await history.text();
  assert(history.status === 200
    && historyHtml.includes(shortUrl.pathname.slice(1))
    && historyHtml.includes(d3ShortUrl.pathname.slice(1))
    && historyHtml.includes(destination)
    && historyHtml.includes(d3Destination),
  "Authenticated history did not reload both committed domain links");
  checks.push("authenticated_persisted_history");

  const deleteForm = new FormData();
  deleteForm.set("csrf", loginBody.csrf);
  deleteForm.set("action", "delete");
  deleteForm.set("domain_id", "3");
  deleteForm.set("code", d3ShortUrl.pathname.slice(1));
  const deleted = await request(port, "url6x.local", "/api.php", {
    method: "POST",
    headers: { cookie },
    body: deleteForm,
  });
  assert(deleted.status === 200 && (await deleted.json()).ok === true, "Owner-scoped delete failed");
  const deletedRedirect = await request(port, "plays9x.local", d3ShortUrl.pathname, { redirect: "manual" });
  assert(deletedRedirect.status === 404, "Deleted Plays9X link still resolved");
  checks.push("owner_delete_and_redirect_invalidation");

  const diagnostics = await request(port, "url6x.local", "/__pilot/headers");
  assert(diagnostics.status === 404, "Pilot diagnostics were unexpectedly enabled");
  checks.push("pilot_diagnostics_disabled");

  const logout = await request(port, "url6x.local", "/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf: loginBody.csrf }),
  });
  assert(logout.status === 200 && (await logout.json()).ok === true, "Logout failed");
  assert(logout.headers.getSetCookie().some((value) => value.startsWith("node_shortener_session=") && /Max-Age=0/i.test(value)),
    "Logout did not clear the session cookie");
  const afterLogout = await request(port, "url6x.local", "/", { headers: { cookie } });
  const afterLogoutHtml = await afterLogout.text();
  assert(afterLogout.status === 200 && afterLogoutHtml.includes('id="loginForm"')
    && !afterLogoutHtml.includes("Account history"), "Revoked session still opened the dashboard");
  checks.push("logout_revokes_session_and_clears_cookie");

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  if (processOutput.trim() !== "") {
    process.stderr.write(`server output:\n${processOutput.slice(-4_000)}\n`);
  }
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await removeOwnedTemporaryDirectory(temporaryRoot);
}

async function request(portNumber, host, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("host", host);
  const body = await serializeBody(options.body, headers);
  if (body !== null) {
    headers.set("content-length", String(body.length));
  }
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
    if (spawned.exitCode !== null) {
      throw new Error(`Local server exited before readiness. ${output().slice(-1_000)}`);
    }
    try {
      const response = await request(portNumber, "url6x.local", "/health/live");
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Local server did not become ready within 20 seconds");
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
  if (!resolved.startsWith(temporaryBase) || !basename(resolved).startsWith("node-shortener-smoke-")) {
    throw new Error("Refusing to remove a directory outside the owned smoke-test path");
  }
  await rm(resolved, { recursive: true, force: true });
}
