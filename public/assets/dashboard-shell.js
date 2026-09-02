(function () {
  "use strict";

  window.__dashboardRegistrationContract = Object.freeze({
    classifyResponse: classifyRegistrationResponse,
    validateInput: validateRegistrationInput
  });
  initialisePublicAuthTabs();
  var loginForm = document.getElementById("loginForm");
  if (loginForm) initialiseLogin(loginForm);
  var registrationForm = document.getElementById("registrationForm");
  if (registrationForm) initialiseRegistration(registrationForm);

  var shell = document.querySelector("[data-dashboard-shell]");
  if (!shell) return;

  var csrf = String(shell.dataset.csrf || "");
  var userId = String(shell.dataset.userId || "anon");
  var preferenceScope = shell.dataset.preferenceScope === "browser" ? "browser" : "account";
  var defaultDomainId = String(shell.dataset.defaultDomainId || "");
  var maxBulkLinks = dashboardBulkLimit(shell.dataset.maxBulkLinks);
  var maxBulkImages = dashboardBulkLimit(shell.dataset.maxBulkImages);
  var quickReuseKey = "node-shortener:quick-reuse:v1:" + userId;
  var createModeKey = "node-shortener:create-mode:v1:" + userId;
  var autocompleteKeyPrefix = "node-shortener:autocomplete:v1:" + userId + ":";
  var quickReuseMax = 20;
  var quickReuseTtlMs = 30 * 24 * 60 * 60 * 1000;
  var quickReuseFutureSkewMs = 5 * 60 * 1000;
  var browserDomainKey = "node-shortener:domain-default:v1:" + userId;
  var unavailableUploadError = "One or more uploaded images are unavailable. Re-upload them.";
  var shieldDate = String(shell.dataset.shieldDate || "");
  var shieldSeenKey = "node-shortener:traffic-shield-seen:v1:" + userId;
  var analytics = [];
  var requestedAnalyticsId = String(shell.dataset.analyticsId || "");
  var requestedAnalyticsSiteKey = String(shell.dataset.analyticsSiteKey || "");
  var analyticsId = /^G-[A-Z0-9]+$/.test(requestedAnalyticsId) ? requestedAnalyticsId : "";
  var analyticsSiteKey = /^[a-z0-9_-]{1,32}$/.test(requestedAnalyticsSiteKey) ? requestedAnalyticsSiteKey : "";
  var analyticsEnabled = shell.dataset.analyticsEnabled === "1" && analyticsId !== "" && analyticsSiteKey !== "";
  var analyticsSchema = Object.freeze({
    dashboard_view: ["load_time_bucket", "quick_reuse_eligible", "page_size_bucket", "domain_id"],
    dashboard_perf: ["visible_card_bucket", "image_request_bucket", "image_transfer_bucket", "image_ready_bucket", "long_task_bucket", "image_origin_class", "domain_id"],
    link_create_ui_ready: ["mode", "create_attempt_bucket", "image_sequence_bucket", "image_submission_source", "quick_reuse", "duration_bucket", "image_state", "image_transfer_bucket", "long_task_bucket", "domain_id"],
    create_mode_selected: ["mode"],
    link_create: ["mode", "domain_id", "result", "count_bucket", "duration_bucket", "failure_type", "failure_reason", "status_group", "quick_reuse", "bulk_pattern", "create_attempt_bucket", "image_sequence_bucket", "image_submission_source"],
    image_upload: ["result", "duration_bucket", "failure_type", "failure_reason", "status_group"],
    link_delete: ["result", "duration_bucket", "failure_type", "failure_reason", "status_group"],
    link_copy: ["surface", "result"],
    link_open: ["surface"],
    bulk_export: ["export_type"],
    quick_reuse_use: ["mode", "rank"],
    quick_reuse_clear: [],
    dashboard_error: ["source", "failure_type"]
  });
  var analyticsValues = Object.freeze({
    mode: ["single", "bulk"],
    result: ["success", "partial", "failure"],
    count_bucket: ["0", "1", "2_5", "6_20", "21_100", "101_plus"],
    load_time_bucket: ["under_500ms", "500_999ms", "1_1999s", "2_3999s", "4s_plus", "unknown"],
    page_size_bucket: ["per_20", "per_50", "per_100", "unknown"],
    create_attempt_bucket: ["first", "second", "third_plus"],
    image_sequence_bucket: ["first", "second", "third_plus", "not_applicable"],
    visible_card_bucket: ["0", "1_4", "5_8", "9_20", "21_plus"],
    image_request_bucket: ["0", "1_4", "5_8", "9_20", "21_plus"],
    image_transfer_bucket: ["none", "zero_or_cached", "unavailable", "partial_unavailable", "under_250kb", "250_999kb", "1_4mb", "5mb_plus"],
    image_ready_bucket: ["none", "all_ready", "some_ready", "none_ready"],
    long_task_bucket: ["unsupported", "none", "under_200ms", "200_999ms", "1s_plus"],
    image_origin_class: ["none", "same_origin_only", "cross_origin_only", "mixed"],
    duration_bucket: ["under_500ms", "500_999ms", "1_1999s", "2_3999s", "4s_plus", "unknown"],
    failure_type: ["auth", "csrf", "security", "validation", "application", "network_or_server", "javascript", "promise", "unknown"],
    failure_reason: ["auth", "security", "validation", "application", "fetch_or_offline", "http_408", "http_429", "http_5xx", "non_json_2xx", "non_json_3xx", "non_json_4xx", "unknown"],
    status_group: ["none", "2xx", "3xx", "4xx", "5xx"],
    bulk_pattern: ["different_urls", "one_per_image"],
    quick_reuse_eligible: ["yes", "no"],
    quick_reuse: ["yes", "no"],
    image_submission_source: ["none", "multipart_upload", "retained_local", "url_input"],
    image_state: ["ready", "no_image", "failed", "timeout", "card_missing", "deferred", "interrupted"],
    surface: ["link_list", "single_result", "bulk_result", "bulk_result_all"],
    export_type: ["copy_all", "download_txt"],
    source: ["window", "promise"],
    rank: ["1", "2", "3"]
  });
  var dashboardPerfSampled = analyticsEnabled && Math.random() < 0.10;
  var dashboardLongTaskSupported = false;
  var dashboardLongTaskTotal = 0;
  var dashboardLongTaskObserver = null;
  var postCreateSampleCount = 0;
  var createAttemptsByMode = { single: 0, bulk: 0 };
  var singleFileIdentityTokens = new WeakMap();
  var nextSingleFileIdentity = 0;
  var lastSingleImageIdentity = null;
  var lastSingleImageAttemptCount = 0;
  var retainedSingleImageBridgeKey = "";
  var retainedSingleImageBridgeIdentity = null;
  var quickReusePendingMode = "";
  var quickReusePendingDestinations = new Set();
  var domainPreferenceRevision = 0;
  var domainPreferenceSaving = false;
  var uploadQueue = Promise.resolve();
  var bulkUploadBusy = 0;
  var imageObserver = createImageObserver();
  window.__dashboardAnalyticsDebug = analytics;

  function dashboardBulkLimit(value) {
    var parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 100;
  }

  function nextCreateAttemptBucket(mode) {
    var key = mode === "bulk" ? "bulk" : "single";
    createAttemptsByMode[key] += 1;
    if (createAttemptsByMode[key] === 1) return "first";
    if (createAttemptsByMode[key] === 2) return "second";
    return "third_plus";
  }

  function localIdentityToken(prefix, value) {
    var input = String(value || "");
    var hash = 2166136261;
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return prefix + ":" + input.length + ":" + (hash >>> 0).toString(16);
  }

  function currentSingleImageIdentity(form) {
    if (!form) return null;
    var picker = form.querySelector("input[name=upload_image]");
    var file = picker && picker.files ? picker.files[0] || null : null;
    if (file) {
      var token = singleFileIdentityTokens.get(file);
      if (!token) {
        nextSingleFileIdentity += 1;
        token = "file:" + nextSingleFileIdentity;
        singleFileIdentityTokens.set(file, token);
      }
      return token;
    }
    var retainedPath = retainedSingleImagePath(form);
    if (retainedPath) {
      var retainedKey = localIdentityToken("retained", retainedPath);
      if (retainedKey === retainedSingleImageBridgeKey && retainedSingleImageBridgeIdentity) {
        return retainedSingleImageBridgeIdentity;
      }
      return retainedKey;
    }
    var imageUrl = form.querySelector("input[name=image_url]");
    var value = imageUrl ? imageUrl.value.trim() : "";
    return value ? localIdentityToken("url", value) : null;
  }

  function nextSingleImageSequenceBucket(identity) {
    if (!identity) return "not_applicable";
    if (identity === lastSingleImageIdentity) lastSingleImageAttemptCount += 1;
    else {
      lastSingleImageIdentity = identity;
      lastSingleImageAttemptCount = 1;
    }
    if (lastSingleImageAttemptCount === 1) return "first";
    if (lastSingleImageAttemptCount === 2) return "second";
    return "third_plus";
  }

  function rememberRetainedSingleImageIdentity(path, identity) {
    if (!path || !identity) return;
    retainedSingleImageBridgeKey = localIdentityToken("retained", path);
    retainedSingleImageBridgeIdentity = identity;
  }

  function clearQuickReusePending() {
    quickReusePendingMode = "";
    quickReusePendingDestinations.clear();
  }

  function quickReuseWasUsed(mode, records) {
    if (quickReusePendingMode !== mode) return false;
    return records.some(function (record) {
      return quickReusePendingDestinations.has(cleanDestination(record.destination));
    });
  }

  initialiseTabs();
  initialiseDomains();
  initialiseSingleImage();
  initialiseAutocomplete();
  initialiseSingleCreate();
  initialiseBulkUploads();
  initialiseBulkCreate();
  initialiseQuickReuse();
  initialiseLogout();
  initialiseCardMenus();
  initialiseShield();
  observeImages(shell);
  initialiseDashboardAnalytics();
  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "hidden") observeImages(document);
    });
  }

  function deleteLink(code, domainId) {
    if (!window.confirm("Delete this link?")) return;
    var startedAt = performanceNow();
    var body = new FormData();
    body.append("action", "delete");
    body.append("code", String(code || ""));
    body.append("domain_id", String(domainId || ""));
    body.append("csrf", csrf);
    safeMutation("/api.php", body).then(function (result) {
      if (result.kind === "ok") {
        var card = document.getElementById("link-card-" + domainId + "-" + code);
        var createdInSession = Boolean(card && card.dataset.sessionCreated === "true");
        if (card) card.remove();
        if (createdInSession) updateSessionCount(-1);
        trackDashboardEvent("link_delete", {
          result: "success",
          duration_bucket: durationBucket(performanceNow() - startedAt),
          status_group: statusGroup(result.status)
        });
        showStatus("Link deleted.", "success");
        return;
      }
      trackDashboardEvent("link_delete", {
        result: "failure",
        duration_bucket: durationBucket(performanceNow() - startedAt),
        failure_type: failureType(result),
        failure_reason: failureReason(result),
        status_group: statusGroup(result.status)
      });
      handleMutationFailure(result, "Delete result is uncertain. Refresh before trying again.");
    });
  }

  function initialiseLogin(form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var status = document.getElementById("loginStatus");
      var button = form.querySelector("button[type=submit]");
      setBusy(button, true, "Signing in…");
      setInlineStatus(status, "Checking your session…", "");
      fetch("/auth/csrf", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(readResponse)
        .then(function (issued) {
          if (!issued.ok || !issued.data || typeof issued.data.csrf !== "string") {
            throw new Error("Could not start a secure sign-in. Refresh and try again.");
          }
          var body = new URLSearchParams();
          body.set("username", String(new FormData(form).get("username") || ""));
          body.set("password", String(new FormData(form).get("password") || ""));
          body.set("csrf", issued.data.csrf);
          return fetch("/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: body.toString()
          }).then(readResponse);
        })
        .then(function (result) {
          if (result.ok && result.data && result.data.ok === true) {
            setInlineStatus(status, "Signed in. Opening the dashboard…", "success");
            window.location.replace("/index.php");
            return;
          }
          var message = result.text || "Sign-in failed.";
          throw new Error(message.trim().slice(0, 240) || "Sign-in failed.");
        })
        .catch(function (error) {
          setInlineStatus(status, error instanceof Error ? error.message : "Sign-in failed.", "error");
        })
        .finally(function () { setBusy(button, false); });
    });
  }

  function initialisePublicAuthTabs() {
    var loginTab = document.getElementById("loginAuthTab");
    var registrationTab = document.getElementById("registerAuthTab");
    if (!loginTab || !registrationTab) return;
    loginTab.addEventListener("click", function () { showAuthPanel("login"); });
    registrationTab.addEventListener("click", function () { showAuthPanel("registration"); });
  }

  function showAuthPanel(panel) {
    var loginTab = document.getElementById("loginAuthTab");
    var registrationTab = document.getElementById("registerAuthTab");
    var loginPanel = document.getElementById("loginPanel");
    var registrationPanel = document.getElementById("registrationPanel");
    if (!loginTab || !registrationTab || !loginPanel || !registrationPanel) return;
    var showRegistration = panel === "registration";
    loginTab.classList.toggle("active", !showRegistration);
    registrationTab.classList.toggle("active", showRegistration);
    loginTab.setAttribute("aria-selected", showRegistration ? "false" : "true");
    registrationTab.setAttribute("aria-selected", showRegistration ? "true" : "false");
    loginPanel.hidden = showRegistration;
    registrationPanel.hidden = !showRegistration;
    var focusTarget = showRegistration
      ? document.getElementById("registrationUsername")
      : document.getElementById("loginUsername");
    if (focusTarget) focusTarget.focus();
  }

  function initialiseRegistration(form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var status = document.getElementById("registrationStatus");
      var button = form.querySelector("button[type=submit]");
      var usernameInput = form.querySelector("[name=username]");
      var passwordInput = form.querySelector("[name=password]");
      var confirmationInput = form.querySelector("[name=password2]");
      var values = {
        username: phpTrim(String(usernameInput && usernameInput.value || "")),
        password: String(passwordInput && passwordInput.value || ""),
        password2: String(confirmationInput && confirmationInput.value || "")
      };
      setRegistrationValidity(usernameInput, passwordInput, confirmationInput, "");
      var validationError = validateRegistrationInput(values);
      if (validationError) {
        setInlineStatus(status, validationError, "error");
        setRegistrationValidity(usernameInput, passwordInput, confirmationInput, validationError);
        focusInvalidRegistrationField(validationError, usernameInput, passwordInput, confirmationInput);
        return;
      }
      if (usernameInput) usernameInput.value = values.username;
      setBusy(button, true, "Creating account…");
      setInlineStatus(status, "Checking sign-up availability…", "");
      fetch("/auth/csrf", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(readResponse)
        .then(function (issued) {
          if (!issued.ok || !issued.data || typeof issued.data.csrf !== "string"
            || !/^[a-f0-9]{64}$/.test(issued.data.csrf)) {
            throw new Error("Could not start a secure sign-up. Refresh and try again.");
          }
          var body = new URLSearchParams();
          body.set("username", values.username);
          body.set("password", values.password);
          body.set("password2", values.password2);
          body.set("csrf", issued.data.csrf);
          return fetch("/auth/register", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: body.toString()
          }).then(readResponse);
        })
        .then(function (result) {
          var outcome = classifyRegistrationResponse(result);
          if (outcome === "authenticated") {
            form.reset();
            setInlineStatus(status, "Account created. Opening your dashboard…", "success");
            window.location.replace("/index.php");
            return;
          }
          if (outcome === "login_required") {
            var createdUsername = result.data.user.username;
            form.reset();
            showAuthPanel("login");
            var loginUsername = document.getElementById("loginUsername");
            var loginPassword = document.getElementById("loginPassword");
            if (loginUsername) loginUsername.value = createdUsername;
            setInlineStatus(
              document.getElementById("loginStatus"),
              "Account created, but sign-in could not be started. Sign in with the password you just chose; do not create the account again.",
              "success"
            );
            if (loginPassword) loginPassword.focus();
            return;
          }
          var message = String(result.text || "Could not create your account.").trim().slice(0, 240)
            || "Could not create your account.";
          if (result.status === 403 && message === "Sign-up is currently closed.") {
            closeRegistrationUi(message + " Existing users can still sign in.");
          }
          throw new Error(message);
        })
        .catch(function (error) {
          setInlineStatus(status, error instanceof Error ? error.message : "Could not create your account.", "error");
        })
        .finally(function () {
          if (form.dataset.registrationClosed !== "true") setBusy(button, false);
        });
    });
  }

  function validateRegistrationInput(values) {
    var username = phpTrim(String(values && values.username || ""));
    var password = String(values && values.password || "");
    var password2 = String(values && values.password2 || "");
    if (!username) return "Please choose a username.";
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
      return "Username must be 3–64 characters: letters, numbers, and _ . - only.";
    }
    var passwordBytes = utf8ByteLength(password);
    if (passwordBytes < 8) return "Password must be at least 8 UTF-8 bytes.";
    if (passwordBytes > 72) return "Password must be at most 72 UTF-8 bytes.";
    if (password !== password2) return "The two passwords do not match.";
    return "";
  }

  function classifyRegistrationResponse(result) {
    var data = result && result.data;
    var safeUser = data && data.user && typeof data.user === "object"
      && typeof data.user.username === "string" && data.user.username.length > 0
      && data.user.role === "user";
    if (!result || result.status !== 201 || !data || data.ok !== true || !safeUser) return "error";
    if (data.status === "authenticated" && data.login_required === false
      && typeof data.csrf === "string" && /^[a-f0-9]{64}$/.test(data.csrf)) {
      return "authenticated";
    }
    if (data.status === "account_created" && data.login_required === true) return "login_required";
    return "error";
  }

  function phpTrim(value) {
    return value.replace(/^[\u0000\t\n\v\r ]+|[\u0000\t\n\v\r ]+$/g, "");
  }

  function utf8ByteLength(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
    try { return unescape(encodeURIComponent(value)).length; } catch (_) { return value.length; }
  }

  function focusInvalidRegistrationField(message, username, password, confirmation) {
    if (message.indexOf("Username") === 0 || message.indexOf("choose a username") !== -1) {
      if (username) username.focus();
      return;
    }
    if (message.indexOf("Password") === 0) {
      if (password) password.focus();
      return;
    }
    if (confirmation) confirmation.focus();
  }

  function setRegistrationValidity(username, password, confirmation, message) {
    var usernameInvalid = message.indexOf("Username") === 0 || message.indexOf("choose a username") !== -1;
    var passwordInvalid = message.indexOf("Password") === 0;
    var confirmationInvalid = message.indexOf("two passwords") !== -1;
    if (username) username.setAttribute("aria-invalid", usernameInvalid ? "true" : "false");
    if (password) password.setAttribute("aria-invalid", passwordInvalid ? "true" : "false");
    if (confirmation) confirmation.setAttribute("aria-invalid", confirmationInvalid ? "true" : "false");
  }

  function closeRegistrationUi(message) {
    var registrationTab = document.getElementById("registerAuthTab");
    var registrationForm = document.getElementById("registrationForm");
    var availability = document.getElementById("registrationAvailability");
    if (registrationTab) registrationTab.disabled = true;
    if (registrationForm) {
      registrationForm.dataset.registrationClosed = "true";
      registrationForm.querySelectorAll("input,button").forEach(function (field) { field.disabled = true; });
    }
    if (availability) {
      availability.textContent = message;
      availability.classList.add("warning");
    }
    showAuthPanel("login");
  }

  function initialiseTabs() {
    var singleTab = document.getElementById("singleTab");
    var bulkTab = document.getElementById("bulkTab");
    var singlePanel = document.getElementById("singlePanel");
    var bulkPanel = document.getElementById("bulkPanel");
    if (!singleTab || !bulkTab || !singlePanel || !bulkPanel) return;
    function select(mode, remember) {
      var single = mode === "single";
      var wasSingle = !singlePanel.hidden;
      singleTab.classList.toggle("active", single);
      bulkTab.classList.toggle("active", !single);
      singleTab.setAttribute("aria-selected", single ? "true" : "false");
      bulkTab.setAttribute("aria-selected", single ? "false" : "true");
      singlePanel.hidden = !single;
      bulkPanel.hidden = single;
      if (wasSingle !== single) {
        var tray = document.getElementById("resultTray");
        if (tray) { tray.replaceChildren(); tray.hidden = true; }
        if (remember !== false) trackDashboardEvent("create_mode_selected", { mode: single ? "single" : "bulk" });
      }
      if (remember !== false) {
        try { localStorage.setItem(createModeKey, single ? "single" : "bulk"); } catch (_) {}
      }
      renderQuickReuse();
    }
    singleTab.addEventListener("click", function () { select("single", true); });
    bulkTab.addEventListener("click", function () { select("bulk", true); });
    var saved = "single";
    try { if (localStorage.getItem(createModeKey) === "bulk") saved = "bulk"; } catch (_) {}
    select(saved, false);
  }

  function initialiseDomains() {
    var selects = domainSelects();
    if (!selects.length) return;
    var browserDefault = "";
    if (preferenceScope === "browser") {
      try { browserDefault = String(localStorage.getItem(browserDomainKey) || ""); } catch (_) {}
    }
    if (optionExists(browserDefault)) defaultDomainId = browserDefault;
    var initial = optionExists(browserDefault) ? browserDefault : defaultDomainId;
    if (!optionExists(initial)) initial = String(selects[0].options[0] && selects[0].options[0].value || "");
    syncDomain(initial);
    selects.forEach(function (select) {
      select.addEventListener("change", function () {
        domainPreferenceRevision += 1;
        syncDomain(select.value);
      });
    });
    var rememberInputs = Array.prototype.slice.call(document.querySelectorAll("[data-remember-domain]"));
    var rememberChoice = rememberInputs.some(function (input) { return input.checked; });
    rememberInputs.forEach(function (input) {
      input.checked = rememberChoice;
      input.addEventListener("change", function () {
        var next = !!input.checked;
        if (next !== rememberChoice) domainPreferenceRevision += 1;
        rememberChoice = next;
        rememberInputs.forEach(function (peer) { if (!peer.disabled) peer.checked = next; });
      });
    });
    if (preferenceScope === "browser" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", function (event) {
        if (event.key !== browserDomainKey) return;
        var next = optionExists(String(event.newValue || ""))
          ? String(event.newValue)
          : String(shell.dataset.defaultDomainId || "");
        if (!optionExists(next) || next === defaultDomainId) return;
        defaultDomainId = next;
        domainPreferenceRevision += 1;
        updateDefaultDomainButtons();
      });
    }
    document.querySelectorAll("[data-set-default-domain]").forEach(function (button) {
      button.addEventListener("click", function () {
        var select = document.getElementById(String(button.dataset.domainTarget || ""));
        if (!select) return;
        saveDefaultDomain(String(select.value || ""), false);
      });
    });
    updateDefaultDomainButtons();
  }

  function domainSelects() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-domain-select]"));
  }

  function optionExists(value) {
    return !!value && domainSelects().some(function (select) {
      return Array.prototype.some.call(select.options, function (option) { return option.value === value; });
    });
  }

  function syncDomain(domainId) {
    domainSelects().forEach(function (select) {
      if (Array.prototype.some.call(select.options, function (option) { return option.value === domainId; })) {
        select.value = domainId;
      }
    });
    updateDefaultDomainButtons();
  }

  function updateDefaultDomainButtons() {
    document.querySelectorAll("[data-set-default-domain]").forEach(function (button) {
      var select = document.getElementById(String(button.dataset.domainTarget || ""));
      var selected = select ? String(select.value || "") : "";
      var current = selected !== "" && selected === defaultDomainId;
      button.disabled = domainPreferenceSaving || current || !optionExists(selected);
      button.textContent = domainPreferenceSaving ? "Saving…" : current ? "Default domain" : "Make my default";
    });
  }

  function initialiseSingleImage() {
    var picker = document.getElementById("singleImagePicker");
    var url = document.getElementById("singleImageUrl");
    var preview = document.getElementById("singleImagePreview");
    var image = preview && preview.querySelector("img");
    var clear = document.getElementById("clearSingleImage");
    var form = picker && picker.form;
    if (!picker || !url || !preview || !image || !clear) return;
    var objectUrl = "";
    if (form) {
      form.releaseSingleImageObjectUrl = function () {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = "";
      };
    }
    function resetPreview(clearInputs) {
      releaseSingleImageObjectUrl(form);
      image.removeAttribute("src");
      preview.hidden = true;
      if (clearInputs) { picker.value = ""; url.value = ""; }
    }
    picker.addEventListener("change", function () {
      clearRetainedSingleImage(form);
      var file = picker.files && picker.files[0];
      if (!file) { resetPreview(false); return; }
      url.value = "";
      resetPreview(false);
      objectUrl = URL.createObjectURL(file);
      image.src = objectUrl;
      preview.hidden = false;
    });
    url.addEventListener("input", function () {
      clearRetainedSingleImage(form);
      var value = url.value.trim();
      if (!value) { resetPreview(false); return; }
      picker.value = "";
      resetPreview(false);
      image.src = value;
      preview.hidden = false;
    });
    clear.addEventListener("click", function () {
      clearRetainedSingleImage(form);
      resetPreview(true);
    });
    window.addEventListener("beforeunload", function () { releaseSingleImageObjectUrl(form); });
  }

  function initialiseSingleCreate() {
    var form = document.getElementById("singleLinkForm");
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var button = document.getElementById("createSingleButton");
      var record = singleReuseRecord(form);
      var quickReuseAttributed = quickReuseWasUsed("single", [record]);
      var remember = !!form.querySelector("[data-remember-domain]:checked");
      var picker = document.getElementById("singleImagePicker");
      var imageUrl = document.getElementById("singleImageUrl");
      var submittedFile = picker && picker.files ? picker.files[0] || null : null;
      var submittedRevision = singleImageRevision(form);
      var submittedPreferenceRevision = domainPreferenceRevision;
      var submittedRetainedPath = !submittedFile && !(imageUrl && imageUrl.value.trim())
        ? retainedSingleImagePath(form)
        : "";
      var submittedImageSource = submittedFile ? "multipart_upload"
        : submittedRetainedPath ? "retained_local"
          : imageUrl && imageUrl.value.trim() ? "url_input" : "none";
      var createAttemptBucket = nextCreateAttemptBucket("single");
      var submittedImageIdentity = currentSingleImageIdentity(form);
      var imageSequenceBucket = nextSingleImageSequenceBucket(submittedImageIdentity);
      var analyticsContext = {
        createAttemptBucket: createAttemptBucket,
        imageSequenceBucket: imageSequenceBucket,
        imageSubmissionSource: submittedImageSource,
        quickReuse: quickReuseAttributed ? "yes" : "no"
      };
      var startedAt = performanceNow();
      var body = csrfFirstFormData(form);
      if (submittedRetainedPath) body.set("image_url", submittedRetainedPath);
      body.append("action", "create_single");
      var domainId = String(body.get("domain_id") || "");
      setBusy(button, true, "Creating…");
      showStatus("Creating the link…", "");
      safeMutation("/api.php", body).then(function (result) {
        if (result.kind !== "ok") {
          if (result.kind === "application" && result.status === 422
            && result.error === unavailableUploadError && submittedRetainedPath
            && submittedRevision === singleImageRevision(form)
            && retainedSingleImagePath(form) === submittedRetainedPath) {
            clearRetainedSingleImage(form);
            clearRetainedSingleImagePreview();
          }
          recordCreateAnalytics("single", domainId, "failure", null, result, startedAt, "", analyticsContext);
          handleMutationFailure(result, "Create result is uncertain. Refresh the link list before submitting again.");
          return;
        }
        var data = result.data;
        var retainedPath = normalizeRetainedSingleImagePath(data.retained_image_path);
        var currentFile = picker && picker.files ? picker.files[0] || null : null;
        if (submittedFile && retainedPath && keepIsOn()
          && submittedRevision === singleImageRevision(form) && currentFile === submittedFile) {
          form.dataset.singleImageRevision = String(submittedRevision + 1);
          form.dataset.retainedImagePath = retainedPath;
          rememberRetainedSingleImageIdentity(retainedPath, submittedImageIdentity);
          if (picker) picker.value = "";
          showRetainedSingleImage(form, retainedPath);
        }
        var postCreatePerformance = beginPostCreatePerformance(
          createAttemptBucket,
          imageSequenceBucket,
          submittedImageSource,
          quickReuseAttributed ? "yes" : "no",
          domainId
        );
        if (typeof data.card === "string") prependCard(data.card);
        saveAutocompleteField(form.querySelector("[name=title]"), "title", 255);
        saveAutocompleteField(form.querySelector("[name=description]"), "description", 2000);
        renderSingleResult(data);
        updateSessionCount(1);
        recordCreateAnalytics("single", domainId, "success", 1, result, startedAt, "", analyticsContext);
        rememberDomainAfterComplete(domainId, remember, submittedPreferenceRevision);
        recordQuickReuse([record]);
        clearQuickReusePending();
        applyKeepSingle(form);
        showStatus("Short link created.", "success");
        finishPostCreatePerformance(postCreatePerformance);
      }).then(undefined, function (error) {
        if (submittedRetainedPath) clearRetainedSingleImage(form);
        throw error;
      }).finally(function () { setBusy(button, false); });
    });
  }

  function initialiseBulkUploads() {
    var picker = document.getElementById("bulkImagePicker");
    if (!picker) return;
    picker.addEventListener("change", function () {
      var files = Array.prototype.slice.call(picker.files || []);
      picker.value = "";
      var accepted = files.slice(0, availableBulkUploadSlots(bulkReadyImageCount(), bulkUploadBusy));
      if (accepted.length < files.length) {
        showStatus("Use no more than " + maxBulkImages + " uploaded images in one batch.", "warning");
      }
      accepted.forEach(function (file) {
        bulkUploadBusy += 1;
        uploadQueue = uploadQueue.then(function () { return uploadBulkImage(file); }).finally(function () { bulkUploadBusy -= 1; });
      });
    });
  }

  function bulkReadyImageCount() {
    var pool = document.getElementById("bulkImagePool");
    return pool ? pool.querySelectorAll("input[name='bulk_image_paths[]']").length : 0;
  }

  function availableBulkUploadSlots(readyCount, busyCount) {
    var ready = Number.isSafeInteger(readyCount) && readyCount > 0 ? readyCount : 0;
    var busy = Number.isSafeInteger(busyCount) && busyCount > 0 ? busyCount : 0;
    return Math.max(0, maxBulkImages - ready - busy);
  }

  function uploadBulkImage(file) {
    var pool = document.getElementById("bulkImagePool");
    if (!pool) return Promise.resolve();
    var chip = document.createElement("article");
    chip.className = "image-chip";
    var name = document.createElement("p");
    name.textContent = file.name;
    var state = document.createElement("p");
    state.textContent = "Uploading…";
    chip.append(name, state);
    pool.appendChild(chip);
    var body = new FormData();
    body.append("csrf", csrf);
    body.append("image", file);
    var startedAt = performanceNow();
    return safeMutation("/upload.php", body).then(function (result) {
      if (result.kind !== "ok" || typeof result.data.path !== "string") {
        trackDashboardEvent("image_upload", {
          result: "failure",
          duration_bucket: durationBucket(performanceNow() - startedAt),
          failure_type: failureType(result),
          failure_reason: failureReason(result),
          status_group: statusGroup(result.status)
        });
        chip.classList.add("failed");
        state.textContent = "Upload failed — remove and choose again.";
        addRemoveButton(chip);
        return;
      }
      var objectUrl = URL.createObjectURL(file);
      var image = document.createElement("img");
      image.alt = "";
      image.src = objectUrl;
      image.addEventListener("load", function () { URL.revokeObjectURL(objectUrl); }, { once: true });
      var hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "bulk_image_paths[]";
      hidden.value = result.data.path;
      trackDashboardEvent("image_upload", {
        result: "success",
        duration_bucket: durationBucket(performanceNow() - startedAt),
        status_group: statusGroup(result.status)
      });
      state.textContent = "Ready";
      chip.prepend(image);
      chip.appendChild(hidden);
      addRemoveButton(chip);
    });
  }

  function addRemoveButton(chip) {
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button quiet";
    remove.textContent = "Remove";
    remove.addEventListener("click", function () { chip.remove(); });
    chip.appendChild(remove);
  }

  function initialiseBulkCreate() {
    var form = document.getElementById("bulkLinkForm");
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var button = document.getElementById("createBulkButton");
      setBusy(button, true, "Preparing…");
      uploadQueue.then(function () {
        if (bulkUploadBusy > 0) throw new Error("Wait for image uploads to finish.");
        var records = bulkReuseRecords(form);
        var quickReuseAttributed = quickReuseWasUsed("bulk", records);
        var body = csrfFirstFormData(form);
        var onePerImage = !!document.getElementById("oneLinkPerImage").checked;
        var paths = Array.prototype.slice.call(form.querySelectorAll("input[name='bulk_image_paths[]']"));
        if (paths.length > maxBulkImages) {
          throw new Error("Use no more than " + maxBulkImages + " uploaded images in one batch.");
        }
        var submittedLinkCount = bulkDestinationCount(form.querySelector("[name=bulk_urls]").value);
        if (onePerImage) {
          if (records.length !== 1) throw new Error("Use exactly one destination URL for one-link-per-image mode.");
          if (!paths.length) throw new Error("Upload at least one image for one-link-per-image mode.");
          submittedLinkCount = paths.length;
          body.set("bulk_urls", paths.map(function () { return records[0].destination; }).join("\n"));
        }
        if (submittedLinkCount > maxBulkLinks) {
          throw new Error("Use no more than " + maxBulkLinks + " destination URLs in one batch.");
        }
        body.append("action", "create_bulk");
        body.append("card_limit", "20");
        var domainId = String(body.get("domain_id") || "");
        var remember = !!form.querySelector("[data-remember-domain]:checked");
        var submittedPreferenceRevision = domainPreferenceRevision;
        var createAttemptBucket = nextCreateAttemptBucket("bulk");
        var analyticsContext = {
          createAttemptBucket: createAttemptBucket,
          imageSequenceBucket: "not_applicable",
          quickReuse: quickReuseAttributed ? "yes" : "no"
        };
        var startedAt = performanceNow();
        setBusy(button, true, "Creating…");
        showStatus("Creating the batch…", "");
        return safeMutation("/api.php", body).then(function (result) {
          if (result.kind !== "ok") {
            recordCreateAnalytics("bulk", domainId, "failure", null, result, startedAt, onePerImage ? "one_per_image" : "different_urls", analyticsContext);
            handleMutationFailure(result, "Bulk result is uncertain. Refresh before submitting this batch again.");
            return;
          }
          var data = result.data;
          var created = nonNegativeCount(data.created);
          var failed = nonNegativeCount(data.failed);
          var outcome = bulkAnalyticsResult(created, failed);
          var complete = created > 0 && failed === 0;
          (Array.isArray(data.cards) ? data.cards : []).forEach(function (card) {
            if (typeof card === "string") prependCard(card);
          });
          updateSessionCount(created);
          renderBulkResult(data, outcome);
          recordCreateAnalytics("bulk", domainId, outcome, created, result, startedAt, onePerImage ? "one_per_image" : "different_urls", analyticsContext);
          clearQuickReusePending();
          if (complete) {
            rememberDomainAfterComplete(domainId, remember, submittedPreferenceRevision);
            recordQuickReuse(records);
            showStatus(created + " link" + (created === 1 ? "" : "s") + " created.", "success");
          } else if (created > 0) {
            showStatus(created + " created and " + failed + " failed. Quick Reuse and Remember were not changed.", "warning");
          } else {
            showStatus("No links were created. Quick Reuse and Remember were not changed.", "error");
          }
          if (created > 0) applyKeepBulk(form, data.retained_image_paths);
          if (created > 0) {
            saveAutocompleteField(form.querySelector("[name=bulk_title]"), "title", 255);
            saveAutocompleteField(form.querySelector("[name=bulk_description]"), "description", 2000);
          }
        });
      }).catch(function (error) {
        trackDashboardEvent("dashboard_error", { source: "promise", failure_type: "javascript" });
        showStatus(error instanceof Error ? error.message : "Could not prepare the batch.", "error");
      }).finally(function () { setBusy(button, false); });
    });
  }

  function keepIsOn() {
    var keep = document.getElementById("keepForNext");
    return !!(keep && keep.checked);
  }

  function initialiseAutocomplete() {
    attachAutocomplete(document.querySelector("#singleLinkForm [name=title]"), "title", 255);
    attachAutocomplete(document.querySelector("#singleLinkForm [name=description]"), "description", 2000);
    attachAutocomplete(document.querySelector("#bulkLinkForm [name=bulk_title]"), "title", 255);
    attachAutocomplete(document.querySelector("#bulkLinkForm [name=bulk_description]"), "description", 2000);
  }

  function autocompleteEntries(store, maxLength) {
    try {
      var raw = localStorage.getItem(autocompleteKeyPrefix + store) || "";
      if (!raw || raw.length > 100000) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (value) { return String(value || "").trim().slice(0, maxLength); })
        .filter(function (value) { return value.length >= 2; }).slice(0, 25);
    } catch (_) { return []; }
  }

  function saveAutocompleteField(field, store, maxLength) {
    var value = String(field && field.value || "").trim().slice(0, maxLength);
    if (value.length < 2) return;
    try {
      var normalized = value.toLowerCase().replace(/\s+/g, " ");
      var entries = autocompleteEntries(store, maxLength).filter(function (entry) {
        return entry.toLowerCase().replace(/\s+/g, " ") !== normalized;
      });
      entries.unshift(value);
      localStorage.setItem(autocompleteKeyPrefix + store, JSON.stringify(entries.slice(0, 25)));
    } catch (_) {}
  }

  function attachAutocomplete(field, store, maxLength) {
    if (!field || !field.parentNode || typeof field.parentNode.appendChild !== "function") return;
    var menu = document.createElement("div");
    menu.className = "autocomplete-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    field.parentNode.appendChild(menu);
    var matches = [];
    var active = -1;
    function close() {
      menu.hidden = true;
      menu.replaceChildren();
      matches = [];
      active = -1;
      field.setAttribute("aria-expanded", "false");
    }
    function choose(index) {
      if (index < 0 || index >= matches.length) return;
      field.value = matches[index];
      close();
    }
    function highlight() {
      Array.prototype.forEach.call(menu.children, function (option, index) {
        option.classList.toggle("active", index === active);
      });
    }
    function open() {
      var typed = String(field.value || "").trim().toLowerCase();
      if (typed.length < 2) { close(); return; }
      matches = autocompleteEntries(store, maxLength).filter(function (entry) {
        return entry.toLowerCase().indexOf(typed) !== -1;
      }).slice(0, 5);
      menu.replaceChildren();
      active = -1;
      matches.forEach(function (match, index) {
        var option = document.createElement("button");
        option.type = "button";
        option.className = "autocomplete-option";
        option.setAttribute("role", "option");
        option.textContent = match;
        option.addEventListener("mousedown", function (event) { event.preventDefault(); choose(index); });
        menu.appendChild(option);
      });
      menu.hidden = matches.length === 0;
      field.setAttribute("aria-expanded", matches.length ? "true" : "false");
    }
    field.setAttribute("autocomplete", "off");
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-expanded", "false");
    field.addEventListener("input", open);
    field.addEventListener("focus", open);
    field.addEventListener("keydown", function (event) {
      if (menu.hidden) return;
      if (event.key === "ArrowDown") { event.preventDefault(); active = Math.min(active + 1, matches.length - 1); highlight(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
      else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(active); }
      else if (event.key === "Escape") close();
    });
    field.addEventListener("blur", function () { setTimeout(close, 120); });
  }

  function normalizeRetainedSingleImagePath(value) {
    var path = typeof value === "string" ? value.trim() : "";
    return /^uploads\/[a-f0-9]{16}\.(?:jpg|png|gif|webp)$/.test(path) ? path : "";
  }

  function retainedSingleImagePath(form) {
    return form ? normalizeRetainedSingleImagePath(form.dataset.retainedImagePath) : "";
  }

  function singleImageRevision(form) {
    var value = Number(form && form.dataset.singleImageRevision || "0");
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function clearRetainedSingleImage(form) {
    if (!form) return;
    delete form.dataset.retainedImagePath;
    form.dataset.singleImageRevision = String(singleImageRevision(form) + 1);
  }

  function releaseSingleImageObjectUrl(form) {
    if (form && typeof form.releaseSingleImageObjectUrl === "function") form.releaseSingleImageObjectUrl();
  }

  function showRetainedSingleImage(form, path) {
    releaseSingleImageObjectUrl(form);
    var preview = document.getElementById("singleImagePreview");
    var image = preview && preview.querySelector("img");
    if (!preview || !image) return;
    image.src = "/" + path;
    preview.hidden = false;
  }

  function clearRetainedSingleImagePreview() {
    var preview = document.getElementById("singleImagePreview");
    var image = preview && preview.querySelector("img");
    if (image) image.removeAttribute("src");
    if (preview) preview.hidden = true;
  }

  function applyKeepSingle(form) {
    var destination = form.querySelector("[name=destination]");
    if (keepIsOn()) {
      if (destination) { destination.value = ""; destination.focus(); }
      return;
    }
    ["title", "description", "image_url"].forEach(function (name) {
      var field = form.querySelector("[name='" + name + "']");
      if (field) field.value = "";
    });
    var picker = document.getElementById("singleImagePicker");
    if (picker) picker.value = "";
    releaseSingleImageObjectUrl(form);
    clearRetainedSingleImage(form);
    var preview = document.getElementById("singleImagePreview");
    var image = preview && preview.querySelector("img");
    if (image) image.removeAttribute("src");
    if (preview) preview.hidden = true;
    if (destination) { destination.value = ""; destination.focus(); }
  }

  function applyKeepBulk(form, retainedImagePaths) {
    var urls = form.querySelector("[name=bulk_urls]");
    var pool = document.getElementById("bulkImagePool");
    if (keepIsOn()) {
      if (Array.isArray(retainedImagePaths) && pool) {
        var retained = new Set(retainedImagePaths.map(String));
        pool.querySelectorAll("input[name='bulk_image_paths[]']").forEach(function (input) {
          if (!retained.has(input.value) && input.closest(".image-chip")) input.closest(".image-chip").remove();
        });
      }
      if (urls) { urls.value = ""; urls.focus(); }
      return;
    }
    ["bulk_title", "bulk_description", "bulk_image_url"].forEach(function (name) {
      var field = form.querySelector("[name='" + name + "']");
      if (field) field.value = "";
    });
    if (pool) pool.replaceChildren();
    var picker = document.getElementById("bulkImagePicker");
    if (picker) picker.value = "";
    if (urls) { urls.value = ""; urls.focus(); }
  }

  function rememberDomainAfterComplete(domainId, requested, submittedRevision) {
    if (!requested || submittedRevision !== domainPreferenceRevision
      || !optionExists(domainId) || domainId === defaultDomainId) return;
    saveDefaultDomain(domainId, true);
  }

  function saveDefaultDomain(domainId, afterCreate) {
    if (domainPreferenceSaving || !optionExists(domainId)) return Promise.resolve(false);
    if (domainId === defaultDomainId) {
      updateDefaultDomainButtons();
      if (!afterCreate) showStatus("This is already your default domain.", "success");
      return Promise.resolve(true);
    }
    domainPreferenceRevision += 1;
    domainPreferenceSaving = true;
    updateDefaultDomainButtons();
    if (preferenceScope === "browser") {
      try {
        localStorage.setItem(browserDomainKey, domainId);
        defaultDomainId = domainId;
        showStatus(afterCreate ? "Create completed and this browser remembered the domain." : "Default saved on this browser.", "success");
        return Promise.resolve(true);
      } catch (_) {
        showStatus(afterCreate ? "Create completed, but this browser could not remember the domain." : "This browser could not save the default domain.", "warning");
        return Promise.resolve(false);
      } finally {
        domainPreferenceSaving = false;
        updateDefaultDomainButtons();
      }
    }
    var body = new FormData();
    body.append("action", "set_default_domain");
    body.append("domain_id", domainId);
    body.append("csrf", csrf);
    return safeMutation("/api.php", body).then(function (result) {
      if (result.kind === "ok" && String(result.data.domain_id || "") === domainId) {
        defaultDomainId = domainId;
        showStatus(afterCreate ? "Create completed and the default domain was updated." : "Default domain updated.", "success");
        return true;
      } else {
        if (afterCreate) showStatus("Create completed, but the saved default was not confirmed.", "warning");
        else handleMutationFailure(result, "Default-domain result is uncertain. Refresh before changing it again.");
        return false;
      }
    }).finally(function () {
      domainPreferenceSaving = false;
      updateDefaultDomainButtons();
    });
  }

  function initialiseQuickReuse() {
    renderQuickReuse();
    var clear = document.getElementById("clearQuickReuse");
    if (!clear) return;
    clear.addEventListener("click", function () {
      try { localStorage.removeItem(quickReuseKey); } catch (_) {}
      clearQuickReusePending();
      renderQuickReuse();
      trackDashboardEvent("quick_reuse_clear", {});
    });
  }

  function readQuickReuse() {
    try {
      var raw = localStorage.getItem(quickReuseKey) || "";
      if (!raw || raw.length > 200000) return [];
      var parsed = JSON.parse(raw);
      var items = Array.isArray(parsed) ? parsed : parsed && parsed.version === 1 && Array.isArray(parsed.items) ? parsed.items : [];
      var now = Date.now();
      var byDestination = new Map();
      items.slice(0, 100).forEach(function (item) {
        if (!item || typeof item.destination !== "string") return;
        var destination = cleanDestination(item.destination);
        var count = Math.min(9999, Math.max(1, Math.floor(Number(item.count) || 0)));
        var lastUsed = Math.floor(Number(item.lastUsed) || 0);
        if (!destination || !lastUsed || lastUsed < now - quickReuseTtlMs || lastUsed > now + quickReuseFutureSkewMs) return;
        var clean = {
          destination: destination,
          title: String(item.title || "").slice(0, 255),
          description: String(item.description || "").slice(0, 2000),
          count: count,
          lastUsed: lastUsed
        };
        var existing = byDestination.get(destination);
        if (!existing || clean.lastUsed > existing.lastUsed) byDestination.set(destination, clean);
        else if (clean.count > existing.count) existing.count = clean.count;
      });
      return Array.from(byDestination.values()).sort(function (left, right) {
        return right.count - left.count || right.lastUsed - left.lastUsed;
      }).slice(0, quickReuseMax);
    } catch (_) { return []; }
  }

  function recordQuickReuse(records) {
    var entries = readQuickReuse();
    records.slice(0, 500).forEach(function (record) {
      if (!record.destination) return;
      var existing = entries.find(function (item) { return item.destination === record.destination; });
      if (existing) {
        existing.count = Math.min(9999, existing.count + 1);
        existing.title = record.title;
        existing.description = record.description;
        existing.lastUsed = Date.now();
      } else {
        entries.push({ destination: record.destination, title: record.title, description: record.description, count: 1, lastUsed: Date.now() });
      }
    });
    entries.sort(function (left, right) { return right.count - left.count || right.lastUsed - left.lastUsed; });
    try { localStorage.setItem(quickReuseKey, JSON.stringify({ version: 1, items: entries.slice(0, quickReuseMax) })); } catch (_) {}
    renderQuickReuse();
  }

  function renderQuickReuse() {
    var root = document.getElementById("quickReuse");
    var list = document.getElementById("quickReuseList");
    if (!root || !list) return;
    var entries = readQuickReuse().filter(function (item) { return item.count >= 2; }).slice(0, 3);
    root.hidden = entries.length === 0;
    list.replaceChildren();
    entries.forEach(function (entry, index) {
      var row = document.createElement("article");
      row.className = "reuse-row";
      var copy = document.createElement("div");
      var destination = document.createElement("strong");
      destination.textContent = entry.destination;
      var meta = document.createElement("p");
      meta.className = "result-destination";
      meta.textContent = "Used " + entry.count + " times on this device";
      copy.append(destination, meta);
      var use = document.createElement("button");
      use.type = "button";
      use.className = "button quiet";
      use.textContent = document.getElementById("bulkPanel") && !document.getElementById("bulkPanel").hidden ? "Add to Bulk" : "Use details";
      use.addEventListener("click", function () {
        var bulk = document.getElementById("bulkPanel") && !document.getElementById("bulkPanel").hidden;
        applyQuickReuse(entry);
        trackDashboardEvent("quick_reuse_use", { mode: bulk ? "bulk" : "single", rank: String(index + 1) });
      });
      row.append(copy, use);
      list.appendChild(row);
    });
  }

  function applyQuickReuse(entry) {
    var bulkPanel = document.getElementById("bulkPanel");
    if (bulkPanel && !bulkPanel.hidden) {
      var bulk = document.getElementById("bulkLinkForm");
      var urls = bulk && bulk.querySelector("[name=bulk_urls]");
      if (!urls) return;
      var title = bulk.querySelector("[name=bulk_title]");
      var description = bulk.querySelector("[name=bulk_description]");
      var beforeUrls = urls.value;
      var beforeTitle = title ? title.value : "";
      var beforeDescription = description ? description.value : "";
      var onePerImage = !!(document.getElementById("oneLinkPerImage") && document.getElementById("oneLinkPerImage").checked);
      var existing = urls.value.split(/\r?\n/).map(function (value) { return value.trim(); }).filter(Boolean);
      if (onePerImage) existing = [entry.destination];
      else if (existing.indexOf(entry.destination) === -1) existing.push(entry.destination);
      urls.value = existing.join("\n");
      if (title && !title.value) title.value = entry.title || "";
      if (description && !description.value) description.value = entry.description || "";
      if (urls.value !== beforeUrls || (title && title.value !== beforeTitle)
        || (description && description.value !== beforeDescription)) {
        if (quickReusePendingMode !== "bulk" || onePerImage) quickReusePendingDestinations.clear();
        quickReusePendingMode = "bulk";
        quickReusePendingDestinations.add(cleanDestination(entry.destination));
      }
      urls.focus();
      return;
    }
    var single = document.getElementById("singleLinkForm");
    if (!single) return;
    var destination = single.querySelector("[name=destination]");
    var singleTitle = single.querySelector("[name=title]");
    var singleDescription = single.querySelector("[name=description]");
    var beforeDestination = destination ? destination.value : "";
    var beforeSingleTitle = singleTitle ? singleTitle.value : "";
    var beforeSingleDescription = singleDescription ? singleDescription.value : "";
    if (destination) destination.value = entry.destination;
    if (singleTitle) singleTitle.value = entry.title || "";
    if (singleDescription) singleDescription.value = entry.description || "";
    if ((destination && destination.value !== beforeDestination)
      || (singleTitle && singleTitle.value !== beforeSingleTitle)
      || (singleDescription && singleDescription.value !== beforeSingleDescription)) {
      quickReusePendingMode = "single";
      quickReusePendingDestinations.clear();
      quickReusePendingDestinations.add(cleanDestination(entry.destination));
    }
    if (destination) destination.focus();
  }

  function singleReuseRecord(form) {
    return {
      destination: cleanDestination(form.querySelector("[name=destination]").value),
      title: String(form.querySelector("[name=title]").value || "").slice(0, 255),
      description: String(form.querySelector("[name=description]").value || "").slice(0, 2000)
    };
  }

  function bulkReuseRecords(form) {
    var title = String(form.querySelector("[name=bulk_title]").value || "").slice(0, 255);
    var description = String(form.querySelector("[name=bulk_description]").value || "").slice(0, 2000);
    var seen = new Set();
    return String(form.querySelector("[name=bulk_urls]").value || "").split(/\r?\n/).map(cleanDestination).filter(function (destination) {
      if (!destination || seen.has(destination)) return false;
      seen.add(destination);
      return true;
    }).map(function (destination) { return { destination: destination, title: title, description: description }; });
  }

  function bulkDestinationCount(value) {
    return String(value || "").split(/\r\n|\r|\n/).map(function (destination) {
      return destination.trim();
    }).filter(Boolean).length;
  }

  function cleanDestination(value) {
    var text = String(value || "").trim().slice(0, 2048);
    try {
      var parsed = new URL(text);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? text : "";
    } catch (_) { return ""; }
  }

  function renderSingleResult(data) {
    var tray = resultTray("Short link created");
    if (!tray || typeof data.short !== "string") return;
    tray.appendChild(resultRow({ short: data.short, destination_url: data.destination_url || "" }));
  }

  function renderBulkResult(data, outcome) {
    var created = nonNegativeCount(data.created);
    var failed = nonNegativeCount(data.failed);
    var tray = resultTray(created + " created" + (failed ? ", " + failed + " failed" : "") + " — " + outcome);
    if (!tray) return;
    var items = Array.isArray(data.items) ? data.items : [];
    var allShorts = items.map(function (item) { return typeof item.short === "string" ? item.short.trim() : ""; }).filter(Boolean).join("\n");
    if (allShorts) {
      var exportActions = document.createElement("div");
      exportActions.className = "row-actions bulk-export-actions";
      var copyAll = document.createElement("button");
      copyAll.type = "button";
      copyAll.className = "button quiet";
      copyAll.textContent = "Copy all";
      copyAll.addEventListener("click", function () {
        trackDashboardEvent("bulk_export", { export_type: "copy_all" });
        copyText(allShorts, copyAll, "bulk_result_all");
      });
      var download = document.createElement("button");
      download.type = "button";
      download.className = "button quiet";
      download.textContent = "Download .txt";
      download.addEventListener("click", function () {
        trackDashboardEvent("bulk_export", { export_type: "download_txt" });
        downloadText("short-links.txt", allShorts + "\n");
      });
      exportActions.append(copyAll, download);
      tray.appendChild(exportActions);
    }
    var list = document.createElement("div");
    list.className = "result-list";
    items.slice(0, 20).forEach(function (item) { list.appendChild(resultRow(item, "bulk_result")); });
    tray.appendChild(list);
    if (items.length > 20) {
      var more = document.createElement("p");
      more.className = "panel-note";
      more.textContent = "+" + (items.length - 20) + " more created — all are included in Copy all and Download.";
      tray.appendChild(more);
    }
    observeImages(tray);
  }

  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (_) {
      showStatus("Download failed.", "error");
    }
  }

  function resultTray(title) {
    var tray = document.getElementById("resultTray");
    if (!tray) return null;
    tray.replaceChildren();
    tray.hidden = false;
    var heading = document.createElement("h2");
    heading.textContent = title;
    tray.appendChild(heading);
    return tray;
  }

  function resultRow(item, surface) {
    var row = document.createElement("article");
    row.className = "result-row";
    var copy = document.createElement("div");
    var link = document.createElement("a");
    link.href = String(item.short || "#");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = String(item.short || "");
    link.addEventListener("click", function () { trackDashboardEvent("link_open", { surface: surface || "single_result" }); });
    copy.appendChild(link);
    var details = destinationDetails(item.destination_url || item.destination || "");
    if (details.target || details.attribution) {
      var destination = document.createElement("p");
      destination.className = "result-destination";
      var target = document.createElement("span");
      target.textContent = details.target;
      destination.appendChild(target);
      if (details.attribution) {
        var attribution = document.createElement("span");
        attribution.className = "result-attribution";
        attribution.textContent = details.attribution;
        destination.appendChild(attribution);
      }
      copy.appendChild(destination);
    }
    var actions = document.createElement("div");
    actions.className = "row-actions";
    var copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "button quiet";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", function () { copyText(String(item.short || ""), copyButton, surface || "single_result"); });
    var open = document.createElement("a");
    open.className = "button quiet";
    open.href = String(item.short || "#");
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";
    open.addEventListener("click", function () { trackDashboardEvent("link_open", { surface: surface || "single_result" }); });
    actions.append(copyButton, open);
    row.append(copy, actions);
    return row;
  }

  function destinationDetails(raw) {
    var value = String(raw || "").trim();
    try {
      var url = new URL(value);
      var target = url.host + (url.pathname === "/" ? "" : url.pathname);
      var parts = [];
      if (url.searchParams.get("utm_source")) parts.push("Source: " + url.searchParams.get("utm_source"));
      if (url.searchParams.get("utm_medium")) parts.push("Medium: " + url.searchParams.get("utm_medium"));
      return { target: target, attribution: parts.join(" · ") };
    } catch (_) {
      var marker = value.search(/ \| (?:Src|Med): /);
      return { target: marker >= 0 ? value.slice(0, marker) : value, attribution: marker >= 0 ? value.slice(marker + 3) : "" };
    }
  }

  function prependCard(html) {
    var list = document.getElementById("linksListContainer");
    if (!list) return;
    var empty = document.getElementById("emptyState");
    if (empty) empty.remove();
    var template = document.createElement("template");
    template.innerHTML = String(html).trim();
    var card = template.content.firstElementChild;
    if (!card) return;
    card.dataset.sessionCreated = "true";
    list.prepend(card);
    observeImages(card);
  }

  function updateSessionCount(delta) {
    var count = document.getElementById("sessionLinkCount");
    if (!count) return;
    count.textContent = String(Math.max(0, nonNegativeCount(count.textContent) + delta));
  }

  function createImageObserver() {
    if (!("IntersectionObserver" in window)) return null;
    return new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && document.visibilityState !== "hidden") loadDeferredImage(entry.target);
      });
    }, { rootMargin: "0px", threshold: .01 });
  }

  function observeImages(scope) {
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll("img[data-dashboard-src]").forEach(function (image) {
      image.hidden = false;
      if (document.visibilityState !== "hidden" && isInViewport(image)) loadDeferredImage(image);
      else if (imageObserver) imageObserver.observe(image);
      else if (document.visibilityState !== "hidden") loadDeferredImage(image);
    });
  }

  function loadDeferredImage(image) {
    if (document.visibilityState === "hidden") return;
    var source = image.getAttribute("data-dashboard-src");
    if (!source) return;
    if (imageObserver) imageObserver.unobserve(image);
    image.removeAttribute("data-dashboard-src");
    image.src = source;
  }

  function initialiseLogout() {
    var button = document.getElementById("logoutButton");
    if (!button) return;
    button.addEventListener("click", function () {
      var body = new URLSearchParams();
      body.set("csrf", csrf);
      setBusy(button, true, "Signing out…");
      fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString()
      }).then(readResponse).then(function (result) {
        // A received HTTP response means the server's finally block cleared
        // auth cookies even when one backend revocation returned an honest 503.
        // Clear the browser-only domain choice before surfacing that failure so
        // the next shared-author login falls back to D2 like PHP.
        if (result.status > 0 && preferenceScope === "browser") {
          try { localStorage.removeItem(browserDomainKey); } catch (_) {}
        }
        if (!result.ok) throw new Error("Sign-out could not be confirmed. Refresh and try again.");
        window.location.replace("/index.php");
      }).catch(function (error) {
        showStatus(error instanceof Error ? error.message : "Sign-out failed.", "error");
        setBusy(button, false);
      });
    });
  }

  function initialiseCardMenus() {
    var list = document.getElementById("linksListContainer");
    if (!list) return;
    list.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target : null;
      if (!target) return;
      var copy = target.closest("[data-copy-link]");
      if (copy) {
        copyText(String(copy.dataset.shortUrl || ""), copy, "link_list");
        return;
      }
      var open = target.closest(".link-short");
      if (open) {
        trackDashboardEvent("link_open", { surface: "link_list" });
        return;
      }
      var remove = target.closest("[data-delete-link]");
      if (remove) {
        deleteLink(String(remove.dataset.code || ""), String(remove.dataset.domainId || ""));
        return;
      }
      var toggle = target.closest("[data-kebab-toggle]");
      if (!toggle) return;
      var menu = toggle.parentElement && toggle.parentElement.querySelector("[data-kebab-menu]");
      if (!menu) return;
      menu.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", menu.classList.contains("hidden") ? "false" : "true");
    });
  }

  function initialiseShield() {
    var button = document.getElementById("shieldBell");
    var panel = document.getElementById("shieldPanel");
    var daysTarget = document.getElementById("shieldDays");
    var yesterdayTarget = document.getElementById("shieldYesterday");
    var lifetimeTarget = document.getElementById("shieldTotal");
    var historyTotalTarget = document.getElementById("shieldHistoryTotal");
    var historyLabelTarget = document.getElementById("shieldHistoryLabel");
    var statusTarget = document.getElementById("shieldStatus");
    if (!button || !panel) return;
    var loaded = false;
    var loading = false;

    try {
      if (/^\d{4}-\d{2}-\d{2}$/.test(shieldDate) && localStorage.getItem(shieldSeenKey) === shieldDate) {
        button.classList.add("is-seen");
      }
    } catch (_) {}

    button.addEventListener("click", function (event) {
      event.stopPropagation();
      if (!panel.classList.contains("hidden")) {
        closeShield();
        return;
      }
      panel.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
      markSeen();
      loadShield();
    });
    panel.addEventListener("click", function (event) { event.stopPropagation(); });
    document.addEventListener("click", closeShield);
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || panel.classList.contains("hidden")) return;
      closeShield();
      button.focus();
    });

    function closeShield() {
      panel.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
    }

    function markSeen() {
      button.classList.add("is-seen");
      try {
        if (/^\d{4}-\d{2}-\d{2}$/.test(shieldDate)) localStorage.setItem(shieldSeenKey, shieldDate);
      } catch (_) {}
    }

    function loadShield() {
      if (loaded || loading) return;
      loading = true;
      var body = new FormData();
      body.append("action", "shield_stats");
      body.append("csrf", csrf);
      safeMutation("/api.php", body).then(function (result) {
        if (result.kind === "ok" && renderShield(result.data)) {
          loaded = true;
          return;
        }
        renderShieldError();
      }).finally(function () { loading = false; });
    }

    function renderShield(data) {
      if (!data || data.ok !== true || !Array.isArray(data.days) || data.days.length !== 7) return false;
      var lifetime = formatShieldCounter(data.total);
      var historyTotal = data.history_total === null ? null : formatShieldCounter(data.history_total);
      if (lifetime === null || (data.history_total !== null && historyTotal === null)
        || (data.history_state !== "exact" && data.history_state !== "collecting")) return false;
      var normalizedDays = [];
      for (var index = 0; index < data.days.length; index += 1) {
        var day = data.days[index];
        if (!day || typeof day.label !== "string" || typeof day.iso !== "string"
          || !/^\d{4}-\d{2}-\d{2}$/.test(day.iso)
          || (day.state !== "collecting" && day.state !== "exact" && day.state !== "exact_so_far")) return false;
        var count = day.count === null ? null : formatShieldCounter(day.count);
        if (day.count !== null && count === null) return false;
        normalizedDays.push({ label: day.label, count: count, state: day.state });
      }

      if (lifetimeTarget) lifetimeTarget.textContent = lifetime;
      var yesterday = normalizedDays.find(function (day) { return day.label === "Yesterday"; });
      if (yesterdayTarget) yesterdayTarget.textContent = yesterday && yesterday.count !== null ? yesterday.count : "collecting";
      if (historyTotalTarget) historyTotalTarget.textContent = historyTotal === null ? "collecting" : historyTotal;
      var complete = data.history_state === "exact";
      if (historyLabelTarget) historyLabelTarget.textContent = complete
        ? "Filtered over the last 7 days"
        : "Filtered since compact history activation";
      if (statusTarget) statusTarget.textContent = complete
        ? "Seven India-date buckets are complete and updated only for admitted filtered requests."
        : "Collecting since activation. Incomplete dates are never shown as zero.";
      if (daysTarget) {
        var fragment = document.createDocumentFragment();
        normalizedDays.forEach(function (day) {
          var row = document.createElement("p");
          row.className = "shield-row";
          var label = document.createElement("span");
          label.textContent = day.label;
          var count = document.createElement("span");
          count.className = "shield-row-count" + (day.count === "0" ? " is-zero" : "");
          count.textContent = day.count === null
            ? "Collecting"
            : day.count + " filtered" + (day.state === "collecting" ? " · partial" : "");
          row.append(label, count);
          fragment.append(row);
        });
        daysTarget.replaceChildren(fragment);
      }
      return true;
    }

    function renderShieldError() {
      loaded = false;
      if (yesterdayTarget) yesterdayTarget.textContent = "—";
      if (lifetimeTarget) lifetimeTarget.textContent = "—";
      if (historyTotalTarget) historyTotalTarget.textContent = "—";
      if (statusTarget) statusTarget.textContent = "Protection history is temporarily unavailable.";
      if (daysTarget) {
        var row = document.createElement("p");
        row.className = "shield-row";
        var message = document.createElement("span");
        message.textContent = "Try opening the report again shortly.";
        row.append(message);
        daysTarget.replaceChildren(row);
      }
    }
  }

  function formatShieldCounter(value) {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function addPostCreateLongTasks(context, entries) {
    if (!context || !Array.isArray(entries)) return;
    entries.forEach(function (entry) {
      context.longTaskTotal += Math.max(0, Number(entry.duration) || 0);
    });
  }

  function postCreateLongTaskBucket(context) {
    if (!context || !context.longTaskSupported) return "unsupported";
    if (context.longTaskTotal <= 0) return "none";
    if (context.longTaskTotal < 200) return "under_200ms";
    if (context.longTaskTotal < 1000) return "200_999ms";
    return "1s_plus";
  }

  function beginPostCreatePerformance(attemptBucket, imageSequence, imageSource, quickReuse, domainId) {
    if (!dashboardPerfSampled || postCreateSampleCount >= 3) return null;
    try {
      var container = document.getElementById("linksListContainer");
      var context = {
        attemptBucket: attemptBucket,
        imageSequence: imageSequence,
        imageSource: imageSource,
        quickReuse: quickReuse,
        domainId: domainId,
        started: performanceNow(),
        beforeFirstCard: container ? container.firstElementChild : null,
        finished: false,
        timeout: 0,
        image: null,
        loadHandler: null,
        errorHandler: null,
        visibilityHandler: null,
        pagehideHandler: null,
        longTaskSupported: false,
        longTaskTotal: 0,
        observer: null
      };
      var Observer = window.PerformanceObserver;
      var supportsLongTasks = typeof Observer === "function"
        && Array.isArray(Observer.supportedEntryTypes)
        && Observer.supportedEntryTypes.indexOf("longtask") !== -1;
      if (supportsLongTasks) {
        try {
          context.longTaskSupported = true;
          context.observer = new Observer(function (list) {
            addPostCreateLongTasks(context, list.getEntries());
          });
          context.observer.observe({ type: "longtask" });
        } catch (_) {
          context.longTaskSupported = false;
          context.observer = null;
        }
      }
      postCreateSampleCount += 1;
      return context;
    } catch (_) {
      return null;
    }
  }

  function postCreateTransferBucket(image, startedAt) {
    if (!image || image.hasAttribute("data-dashboard-src")) return "none";
    var href = "";
    try { href = new URL(image.currentSrc || image.src || "", window.location.href).href; }
    catch (_) { return "unavailable"; }
    var resources;
    try {
      resources = performanceEntries("resource").filter(function (entry) {
        return entry.initiatorType === "img" && entry.name === href
          && Number(entry.startTime) >= startedAt;
      });
    } catch (_) {
      return "unavailable";
    }
    if (!resources.length) return "unavailable";
    return dashboardTransferBucket([resources[resources.length - 1]]);
  }

  function cleanupPostCreateObserver(context) {
    if (!context || !context.observer) return;
    try {
      if (typeof context.observer.takeRecords === "function") {
        addPostCreateLongTasks(context, context.observer.takeRecords());
      }
      context.observer.disconnect();
    } catch (_) {}
    context.observer = null;
  }

  function cleanupPostCreatePerformance(context, includeObserver) {
    if (!context) return;
    if (context.timeout) clearTimeout(context.timeout);
    context.timeout = 0;
    if (context.image && context.loadHandler) context.image.removeEventListener("load", context.loadHandler);
    if (context.image && context.errorHandler) context.image.removeEventListener("error", context.errorHandler);
    if (context.visibilityHandler && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", context.visibilityHandler);
    }
    if (context.pagehideHandler && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", context.pagehideHandler);
    }
    if (includeObserver !== false) cleanupPostCreateObserver(context);
    context.loadHandler = null;
    context.errorHandler = null;
    context.visibilityHandler = null;
    context.pagehideHandler = null;
  }

  function completePostCreatePerformance(context, state) {
    if (!context || context.finished) return;
    context.finished = true;
    var image = context.image;
    cleanupPostCreatePerformance(context, false);
    var emitted = false;
    var fallbackTimer = 0;
    function emit() {
      if (emitted) return;
      emitted = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      cleanupPostCreateObserver(context);
      var ready = image && image.complete && Number(image.naturalWidth) > 0;
      trackDashboardEvent("link_create_ui_ready", {
        mode: "single",
        create_attempt_bucket: context.attemptBucket,
        image_sequence_bucket: context.imageSequence,
        image_submission_source: context.imageSource,
        quick_reuse: context.quickReuse,
        duration_bucket: durationBucket(performanceNow() - context.started),
        image_state: document.visibilityState === "hidden" ? "interrupted" : ready ? "ready" : state,
        image_transfer_bucket: postCreateTransferBucket(image, context.started),
        long_task_bucket: postCreateLongTaskBucket(context),
        domain_id: /^[1-9][0-9]{0,4}$/.test(context.domainId) ? "d" + context.domainId : ""
      });
    }
    if (state === "interrupted") {
      emit();
      return;
    }
    fallbackTimer = setTimeout(emit, 250);
    afterTwoFrames(emit);
  }

  function finishPostCreatePerformance(context) {
    if (!context) return;
    try {
      if (document.visibilityState === "hidden") {
        completePostCreatePerformance(context, "interrupted");
        return;
      }
      var container = document.getElementById("linksListContainer");
      var card = container ? container.firstElementChild : null;
      if (!card || card === context.beforeFirstCard) {
        completePostCreatePerformance(context, "card_missing");
        return;
      }
      var image = card.querySelector ? card.querySelector(".link-thumb img") : null;
      if (!image) {
        completePostCreatePerformance(context, "no_image");
        return;
      }
      context.image = image;
      if (image.hasAttribute("data-dashboard-src") && !isInViewport(image)) {
        completePostCreatePerformance(context, "deferred");
        return;
      }
      if (image.hasAttribute("data-dashboard-src")) loadDeferredImage(image);
      context.loadHandler = function () { completePostCreatePerformance(context, "ready"); };
      context.errorHandler = function () { completePostCreatePerformance(context, "failed"); };
      context.visibilityHandler = function () {
        if (document.visibilityState === "hidden") completePostCreatePerformance(context, "interrupted");
      };
      context.pagehideHandler = function () { completePostCreatePerformance(context, "interrupted"); };
      image.addEventListener("load", context.loadHandler, { once: true });
      image.addEventListener("error", context.errorHandler, { once: true });
      if (typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", context.visibilityHandler);
      }
      if (typeof window.addEventListener === "function") {
        window.addEventListener("pagehide", context.pagehideHandler, { once: true });
      }
      if (image.complete) {
        completePostCreatePerformance(context, Number(image.naturalWidth) > 0 ? "ready" : "failed");
        return;
      }
      context.timeout = setTimeout(function () {
        completePostCreatePerformance(context, "timeout");
      }, 4000);
    } catch (_) {
      cleanupPostCreatePerformance(context);
    }
  }

  function afterTwoFrames(callback) {
    if (typeof window.requestAnimationFrame !== "function") { setTimeout(callback, 0); return; }
    window.requestAnimationFrame(function () { window.requestAnimationFrame(callback); });
  }

  function recordCreateAnalytics(mode, domainId, result, count, response, startedAt, bulkPattern, context) {
    var params = {
      mode: mode,
      domain_id: /^[1-9][0-9]{0,4}$/.test(domainId) ? "d" + domainId : "",
      result: result,
      duration_bucket: durationBucket(performanceNow() - startedAt),
      status_group: statusGroup(response && response.status),
      bulk_pattern: bulkPattern
    };
    if (context) {
      params.create_attempt_bucket = context.createAttemptBucket;
      params.image_sequence_bucket = context.imageSequenceBucket;
      params.image_submission_source = context.imageSubmissionSource;
      params.quick_reuse = context.quickReuse;
    }
    if (count !== null && count !== undefined) params.count_bucket = countBucket(count);
    if (result !== "success") {
      params.failure_type = result === "partial" ? "application" : failureType(response);
      params.failure_reason = result === "partial" ? "application" : failureReason(response);
    }
    trackDashboardEvent("link_create", params);
  }

  function trackDashboardEvent(name, params) {
    var keys = analyticsSchema[name];
    if (!keys) return;
    var input = params && typeof params === "object" ? params : {};
    var safe = analyticsSiteKey ? { site_key: analyticsSiteKey } : {};
    keys.forEach(function (key) {
      var value = String(input[key] === undefined || input[key] === null ? "" : input[key]);
      if (key === "domain_id" && /^d[1-9][0-9]{0,4}$/.test(value)) {
        safe[key] = value;
      } else if (analyticsValues[key] && analyticsValues[key].indexOf(value) !== -1) {
        safe[key] = value;
      }
    });
    analytics.push({ event: name, params: safe });
    if (analytics.length > 100) analytics.shift();
    if (analyticsEnabled && typeof window.gtag === "function") {
      window.gtag("event", name, Object.assign({ send_to: analyticsId }, safe));
    }
  }

  function initialiseDashboardAnalytics() {
    if (typeof window.addEventListener === "function") {
      window.addEventListener("error", function (event) {
        if (event && event.error) {
          trackDashboardEvent("dashboard_error", { source: "window", failure_type: "javascript" });
        }
      });
      window.addEventListener("unhandledrejection", function () {
        trackDashboardEvent("dashboard_error", { source: "promise", failure_type: "promise" });
      });
    }
    if (analyticsEnabled && document.head && typeof document.createElement === "function") {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
      window.gtag("config", analyticsId, {
        send_page_view: false,
        page_location: window.location.origin + window.location.pathname,
        page_referrer: "",
        site_key: analyticsSiteKey,
        allow_google_signals: false,
        allow_ad_personalization_signals: false
      });
      var script = document.createElement("script");
      script.async = true;
      script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(analyticsId);
      document.head.appendChild(script);
    }
    startDashboardLongTaskObserver();
    var record = function () {
      var navigation = performanceEntries("navigation")[0];
      var loadTime = navigation && Number.isFinite(navigation.loadEventEnd) && navigation.loadEventEnd > 0
        ? navigation.loadEventEnd
        : performanceNow();
      trackDashboardEvent("dashboard_view", {
        load_time_bucket: durationBucket(loadTime),
        quick_reuse_eligible: readQuickReuse().some(function (item) { return item.count >= 2; }) ? "yes" : "no",
        page_size_bucket: pageSizeBucket(),
        domain_id: dashboardDomainMetric()
      });
      if (dashboardPerfSampled) setTimeout(recordDashboardPerformance, 2500);
    };
    if (document.readyState === "complete") setTimeout(record, 0);
    else if (typeof window.addEventListener === "function") window.addEventListener("load", record, { once: true });
  }

  function startDashboardLongTaskObserver() {
    var Observer = window.PerformanceObserver;
    if (!dashboardPerfSampled || typeof Observer !== "function"
      || !Array.isArray(Observer.supportedEntryTypes)
      || Observer.supportedEntryTypes.indexOf("longtask") === -1) return;
    try {
      dashboardLongTaskSupported = true;
      dashboardLongTaskObserver = new Observer(function (list) {
        list.getEntries().forEach(function (entry) {
          dashboardLongTaskTotal += Math.max(0, Number(entry.duration) || 0);
        });
      });
      dashboardLongTaskObserver.observe({ type: "longtask", buffered: true });
    } catch (_) {
      dashboardLongTaskSupported = false;
      dashboardLongTaskObserver = null;
    }
  }

  function recordDashboardPerformance() {
    if (document.visibilityState === "hidden") {
      if (dashboardLongTaskObserver) dashboardLongTaskObserver.disconnect();
      dashboardLongTaskObserver = null;
      return;
    }
    var rows = Array.prototype.slice.call(document.querySelectorAll("#linksListContainer .link-row"));
    var images = Array.prototype.slice.call(document.querySelectorAll("#linksListContainer img[data-dashboard-src], #linksListContainer .link-thumb img"));
    var imageUrls = new Set(images.map(function (image) {
      try { return new URL(image.currentSrc || image.src || image.getAttribute("data-dashboard-src") || "", window.location.href).href; }
      catch (_) { return ""; }
    }).filter(Boolean));
    var resources = performanceEntries("resource").filter(function (entry) {
      return entry.initiatorType === "img" && imageUrls.has(entry.name);
    });
    var visibleImages = images.filter(isInViewport);
    trackDashboardEvent("dashboard_perf", {
      visible_card_bucket: dashboardCountBucket(rows.filter(isInViewport).length),
      image_request_bucket: dashboardCountBucket(resources.length),
      image_transfer_bucket: dashboardTransferBucket(resources),
      image_ready_bucket: dashboardReadyBucket(visibleImages),
      long_task_bucket: dashboardLongTaskBucket(),
      image_origin_class: dashboardImageOriginClass(images),
      domain_id: dashboardDomainMetric()
    });
    if (dashboardLongTaskObserver) dashboardLongTaskObserver.disconnect();
    dashboardLongTaskObserver = null;
  }

  function performanceNow() {
    return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function performanceEntries(type) {
    try {
      return typeof performance === "object" && typeof performance.getEntriesByType === "function"
        ? performance.getEntriesByType(type)
        : [];
    } catch (_) { return []; }
  }

  function durationBucket(milliseconds) {
    var value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return "unknown";
    if (value < 500) return "under_500ms";
    if (value < 1000) return "500_999ms";
    if (value < 2000) return "1_1999s";
    if (value < 4000) return "2_3999s";
    return "4s_plus";
  }

  function statusGroup(status) {
    var value = Number(status) || 0;
    if (value >= 200 && value < 300) return "2xx";
    if (value >= 300 && value < 400) return "3xx";
    if (value >= 400 && value < 500) return "4xx";
    if (value >= 500) return "5xx";
    return "none";
  }

  function failureType(response) {
    if (!response || !response.kind) return "unknown";
    if (response.kind === "auth" || response.kind === "security") return response.kind;
    if (response.kind === "application") return response.status === 400 || response.status === 422 ? "validation" : "application";
    if (response.kind === "retryable_precommit") return "application";
    if (response.kind === "uncertain") return "network_or_server";
    return "unknown";
  }

  function failureReason(response) {
    if (!response || !response.kind) return "unknown";
    if (response.kind === "auth" || response.kind === "security") return response.kind;
    if (response.kind === "application") return response.status === 400 || response.status === 422 ? "validation" : "application";
    if (response.kind === "retryable_precommit") return "http_429";
    if (response.kind !== "uncertain") return "unknown";
    var status = Number(response.status) || 0;
    if (status === 0) return "fetch_or_offline";
    if (status === 408) return "http_408";
    if (status === 429) return "http_429";
    if (status >= 500) return "http_5xx";
    if (status >= 400) return "non_json_4xx";
    if (status >= 300) return "non_json_3xx";
    if (status >= 200) return "non_json_2xx";
    return "unknown";
  }

  function pageSizeBucket() {
    var field = document.getElementById("historyPerPage");
    var value = field ? Number(field.value) : 0;
    return value === 20 || value === 50 || value === 100 ? "per_" + value : "unknown";
  }

  function dashboardDomainMetric() {
    var select = domainSelects()[0];
    var value = select ? String(select.value || "") : "";
    return /^[1-9][0-9]{0,4}$/.test(value) ? "d" + value : "";
  }

  function dashboardCountBucket(value) {
    var count = nonNegativeCount(value);
    if (count === 0) return "0";
    if (count <= 4) return "1_4";
    if (count <= 8) return "5_8";
    if (count <= 20) return "9_20";
    return "21_plus";
  }

  function dashboardTransferBucket(entries) {
    if (!entries.length) return "none";
    var total = 0;
    var unavailable = false;
    entries.forEach(function (entry) {
      var transfer = Math.max(0, Number(entry.transferSize) || 0);
      var encoded = Math.max(0, Number(entry.encodedBodySize) || 0);
      var crossOrigin = false;
      try { crossOrigin = new URL(entry.name, window.location.href).origin !== window.location.origin; }
      catch (_) { crossOrigin = true; }
      if (crossOrigin && transfer === 0 && encoded === 0) unavailable = true;
      total += transfer;
    });
    if (unavailable && total > 0) return "partial_unavailable";
    if (unavailable) return "unavailable";
    if (total === 0) return "zero_or_cached";
    if (total < 250 * 1024) return "under_250kb";
    if (total < 1024 * 1024) return "250_999kb";
    if (total < 5 * 1024 * 1024) return "1_4mb";
    return "5mb_plus";
  }

  function dashboardReadyBucket(images) {
    if (!images.length) return "none";
    var ready = images.filter(function (image) { return image.complete && Number(image.naturalWidth) > 0; }).length;
    if (ready === images.length) return "all_ready";
    return ready > 0 ? "some_ready" : "none_ready";
  }

  function dashboardLongTaskBucket() {
    if (!dashboardLongTaskSupported) return "unsupported";
    if (dashboardLongTaskTotal <= 0) return "none";
    if (dashboardLongTaskTotal < 200) return "under_200ms";
    if (dashboardLongTaskTotal < 1000) return "200_999ms";
    return "1s_plus";
  }

  function dashboardImageOriginClass(images) {
    if (!images.length) return "none";
    var same = false;
    var cross = false;
    images.forEach(function (image) {
      try {
        var source = image.currentSrc || image.src || image.getAttribute("data-dashboard-src") || "";
        if (!source) return;
        if (new URL(source, window.location.href).origin === window.location.origin) same = true;
        else cross = true;
      } catch (_) {}
    });
    if (same && cross) return "mixed";
    if (same) return "same_origin_only";
    if (cross) return "cross_origin_only";
    return "none";
  }

  function isInViewport(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    var rect = element.getBoundingClientRect();
    var height = window.innerHeight || document.documentElement.clientHeight || 0;
    var width = window.innerWidth || document.documentElement.clientWidth || 0;
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < height && rect.left < width;
  }

  function bulkAnalyticsResult(created, failed) {
    if (created <= 0) return "failure";
    return failed === 0 ? "success" : "partial";
  }

  function countBucket(value) {
    var count = nonNegativeCount(value);
    if (count === 0) return "0";
    if (count === 1) return "1";
    if (count <= 5) return "2_5";
    if (count <= 20) return "6_20";
    if (count <= 100) return "21_100";
    return "101_plus";
  }

  function nonNegativeCount(value) {
    var count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  function csrfFirstFormData(form) {
    var body = new FormData();
    body.append("csrf", csrf);
    new FormData(form).forEach(function (value, name) {
      if (name !== "csrf") body.append(name, value);
    });
    return body;
  }

  function safeMutation(url, body) {
    return fetch(url, { method: "POST", credentials: "same-origin", body: body, headers: { Accept: "application/json" } })
      .then(readResponse)
      .then(function (response) {
        var data = response.data;
        if (response.status === 429 && data && data.ok === false
          && data.failure_code === "image_processor_busy" && data.link_committed === false && data.retryable === true) {
          return { kind: "retryable_precommit", status: response.status, data: data };
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          return { kind: "uncertain", status: response.status, data: data };
        }
        if (data && data.ok === true) return { kind: "ok", status: response.status, data: data };
        if (response.status === 401) return { kind: "auth", status: response.status, data: data };
        if (response.status === 403) return { kind: "security", status: response.status, data: data };
        if (data && data.ok === false) return { kind: "application", status: response.status, data: data, error: String(data.error || "Request failed") };
        return { kind: "uncertain", status: response.status, data: data };
      }).catch(function () { return { kind: "uncertain", status: 0, data: null }; });
  }

  function readResponse(response) {
    return response.text().then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (_) {}
      return { ok: response.ok, status: response.status, data: data, text: text };
    });
  }

  function handleMutationFailure(result, uncertainMessage) {
    if (result.kind === "retryable_precommit") {
      showStatus("Image processor is busy. No link was created; wait, then submit manually.", "warning");
      return;
    }
    if (result.kind === "application") {
      showStatus(String(result.error || "Request failed."), "error");
      return;
    }
    if (result.kind === "auth") {
      showPersistentNotice("Your session expired. Refresh and sign in before submitting again.");
      return;
    }
    if (result.kind === "security") {
      showPersistentNotice("The security check rejected this request. Refresh before trying again.");
      return;
    }
    showPersistentNotice(uncertainMessage);
  }

  function copyText(text, button, surface) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      trackDashboardEvent("link_copy", { surface: surface, result: "failure" });
      showStatus("Copy is not supported in this browser.", "error");
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      trackDashboardEvent("link_copy", { surface: surface, result: "success" });
      var old = button && button.textContent;
      if (button) button.textContent = "Copied";
      setTimeout(function () { if (button) button.textContent = old; }, 1200);
    }).catch(function () {
      trackDashboardEvent("link_copy", { surface: surface, result: "failure" });
      showStatus("Copy failed.", "error");
    });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
      button.disabled = true;
      button.textContent = label || "Working…";
    } else {
      button.disabled = false;
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    }
  }

  function showStatus(message, kind) {
    setInlineStatus(document.getElementById("dashboardStatus"), message, kind);
  }

  function setInlineStatus(target, message, kind) {
    if (!target) return;
    target.textContent = message;
    target.className = "form-status" + (kind ? " " + kind : "");
  }

  function showPersistentNotice(message) {
    var notice = document.getElementById("persistentNotice");
    if (!notice) return;
    notice.textContent = message;
    notice.hidden = false;
  }
})();
