(function () {
  "use strict";
  var shell = document.querySelector("[data-admin-shell]");
  if (!shell) return;

  var rows = document.getElementById("geoRows");
  var add = document.getElementById("addGeoRow");
  var form = document.getElementById("geoForm");
  var confirmRow = document.getElementById("qualityConfirmRow");

  if (add && rows) {
    add.addEventListener("click", function () {
      if (rows.querySelectorAll("[data-geo-row]").length >= 250) return;
      var row = document.createElement("div");
      row.className = "geo-row";
      row.dataset.geoRow = "";
      row.innerHTML = '<input type="text" maxlength="2" pattern="[A-Za-z]{2}" autocomplete="off" placeholder="CC" aria-label="Country code">'
        + '<input type="number" min="0" max="100" step="1" value="0" aria-label="Diversion percentage">'
        + '<label class="quality-check"><input type="checkbox" value="1"><span>Yes</span></label>'
        + '<button class="button quiet" type="button" data-remove-geo>Remove</button>';
      rows.appendChild(row);
      reindexRows();
      row.querySelector("input").focus();
    });
    rows.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest("[data-remove-geo]") : null;
      if (!target) return;
      var row = target.closest("[data-geo-row]");
      if (row) row.remove();
      reindexRows();
    });
  }

  if (form) {
    form.addEventListener("submit", reindexRows);
    form.querySelectorAll('input[name="quality_mode"]').forEach(function (radio) {
      radio.addEventListener("change", updateQualityConfirmation);
    });
    updateQualityConfirmation();
  }

  document.querySelectorAll("[data-delete-user-form]").forEach(function (deleteForm) {
    deleteForm.addEventListener("submit", function (event) {
      var username = String(deleteForm.dataset.username || "this user");
      if (!window.confirm("Delete " + username + " and all of their links?")) event.preventDefault();
    });
  });

  document.querySelectorAll("[data-reset-session-form]").forEach(function (resetForm) {
    resetForm.addEventListener("submit", function (event) {
      if (!window.confirm("Sign out every other browser and reset all persistent logins?")) {
        event.preventDefault();
      }
    });
  });

  function reindexRows() {
    if (!rows) return;
    rows.querySelectorAll("[data-geo-row]").forEach(function (row, index) {
      var inputs = row.querySelectorAll("input");
      if (inputs[0]) inputs[0].name = "geo_rows[" + index + "][country]";
      if (inputs[1]) inputs[1].name = "geo_rows[" + index + "][percent]";
      if (inputs[2]) inputs[2].name = "geo_rows[" + index + "][quality]";
    });
  }

  function updateQualityConfirmation() {
    if (!form || !confirmRow) return;
    var all = form.querySelector('input[name="quality_mode"]:checked');
    var visible = all && all.value === "all";
    confirmRow.hidden = !visible;
    var checkbox = confirmRow.querySelector("input");
    if (checkbox) {
      checkbox.required = Boolean(visible);
      if (!visible) checkbox.checked = false;
    }
  }
})();
