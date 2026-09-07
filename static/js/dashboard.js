(function () {
  "use strict";

  // Severidade derivada do NOME da classe (mesmo espirito do
  // defaultChartIncluded em app.js) -- assim o dashboard nao precisa de
  // configuracao nova por projeto, so' usa a taxonomia que ja existe.
  // 3 = precisa de acao (corte/poda), 2 = atencao (crescimento moderado),
  // 1 = ok mas com vegetacao baixa/recem cortada, 0 = solo exposto.
  // Paineis/estruturas nunca contam (nao sao vegetacao); "Nao identificado"
  // conta na area mas fica de fora do calculo de severidade (nao se sabe
  // o que e', entao nao dá pra decidir se precisa de acao).
  var SEVERITY_RULES = [
    { weight: 3, re: /seletiva|(?:^|\s)alta\b/i },
    { weight: 2, re: /leve/i },
    { weight: 1, re: /ro[cç]o|baixa/i },
    { weight: 0, re: /^solo$/i }
  ];
  var SEVERITY_COLOR = { 3: "#E74C3C", 2: "#F1C40F", 1: "#2ECC71", 0: "#8B5E34", unclassified: "#9AA0A6" };
  var SEVERITY_TIER_LABEL = { acao: "Ação necessária", atencao: "Atenção", ok: "OK" };

  function isStructureClass(name) { return /painel|estrutura/i.test(name || ""); }

  function classSeverity(name) {
    for (var i = 0; i < SEVERITY_RULES.length; i++) {
      if (SEVERITY_RULES[i].re.test(name || "")) { return SEVERITY_RULES[i].weight; }
    }
    return null; // classe nao reconhecida (ex: "Nao Identificado")
  }

  function fmtArea(m2) {
    return m2 >= 10000 ? (m2 / 10000).toFixed(1) + " ha" : m2.toFixed(0) + " m²";
  }
  function fmtDate(iso) {
    var parts = (iso || "").split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : (iso || "—");
  }

  function flightStats(fl) {
    var bySeverity = { 0: 0, 1: 0, 2: 0, 3: 0 };
    var unclassifiedArea = 0;
    var totalArea = 0;
    var segs = []; // pra barra de cobertura -- ordem: 3,2,1,0,unclassified
    (fl.classes || []).forEach(function (c) {
      if (isStructureClass(c.name)) { return; }
      totalArea += c.areaM2;
      var sev = classSeverity(c.name);
      if (sev == null) { unclassifiedArea += c.areaM2; } else { bySeverity[sev] += c.areaM2; }
    });
    [3, 2, 1, 0].forEach(function (w) {
      if (bySeverity[w] > 0) { segs.push({ areaM2: bySeverity[w], color: SEVERITY_COLOR[w] }); }
    });
    if (unclassifiedArea > 0) { segs.push({ areaM2: unclassifiedArea, color: SEVERITY_COLOR.unclassified }); }

    var tier = "ok";
    if (bySeverity[3] > 0) { tier = "acao"; }
    else if (bySeverity[2] > 0) { tier = "atencao"; }

    var concernArea = bySeverity[2] + bySeverity[3];
    var concernPct = totalArea > 0 ? (concernArea / totalArea * 100) : 0;

    return { tier: tier, totalArea: totalArea, concernPct: concernPct, segs: segs };
  }

  function buildRows(catalog) {
    var rows = [];
    (catalog.projects || []).forEach(function (p) {
      var byBlock = {};
      p.flights.forEach(function (fl) {
        var key = fl.block || "";
        (byBlock[key] = byBlock[key] || []).push(fl);
      });
      Object.keys(byBlock).forEach(function (blockKey) {
        var flights = byBlock[blockKey].filter(function (f) { return f.hasVegetation; })
          .slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }); // desc
        if (flights.length === 0) { return; }
        var latest = flights[0];
        var previous = flights[1] || null;
        var latestStats = flightStats(latest);
        var trend = null;
        if (previous) {
          var prevStats = flightStats(previous);
          trend = latestStats.concernPct - prevStats.concernPct;
        }
        rows.push({
          pid: p.id, pname: p.name, block: blockKey || null, date: latest.date,
          tier: latestStats.tier, totalArea: latestStats.totalArea, segs: latestStats.segs,
          trend: trend
        });
      });
    });
    return rows;
  }

  function buildCoverageBarHtml(segs) {
    if (segs.length === 0) { return '<div class="dash-cov-empty">—</div>'; }
    var total = segs.reduce(function (s, seg) { return s + seg.areaM2; }, 0);
    var parts = segs.map(function (seg) {
      var pct = total > 0 ? (seg.areaM2 / total * 100) : 0;
      return '<div class="dash-cov-seg" style="width:' + pct.toFixed(2) + '%; background:' + seg.color + '"></div>';
    }).join("");
    return '<div class="dash-cov-bar">' + parts + "</div>";
  }

  function buildTrendHtml(trend) {
    if (trend == null) { return '<span class="dash-trend dash-trend-none">— sem voo anterior</span>'; }
    if (Math.abs(trend) < 1) { return '<span class="dash-trend dash-trend-flat">≈ estável</span>'; }
    if (trend > 0) { return '<span class="dash-trend dash-trend-up">▲ +' + trend.toFixed(1) + " pp</span>"; }
    return '<span class="dash-trend dash-trend-down">▼ ' + trend.toFixed(1) + " pp</span>";
  }

  function buildRowHtml(row) {
    var badgeClass = "dash-badge dash-badge-" + row.tier;
    var badgeIcon = row.tier === "acao" ? "🔴" : (row.tier === "atencao" ? "🟡" : "🟢");
    var link = "index.html?project=" + encodeURIComponent(row.pid) + "&date=" + encodeURIComponent(row.date) +
      (row.block ? "&block=" + encodeURIComponent(row.block) : "");
    return (
      '<tr class="dash-row" data-href="' + link + '">' +
        '<td><span class="' + badgeClass + '">' + badgeIcon + " " + SEVERITY_TIER_LABEL[row.tier] + "</span></td>" +
        "<td>" + escapeHtml(row.pname) + "</td>" +
        "<td>" + (row.block ? escapeHtml(row.block) : "—") + "</td>" +
        "<td>" + fmtDate(row.date) + "</td>" +
        "<td>" + buildCoverageBarHtml(row.segs) + "</td>" +
        "<td>" + buildTrendHtml(row.trend) + "</td>" +
        "<td>" + fmtArea(row.totalArea) + "</td>" +
      "</tr>"
    );
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  var allRows = [];

  function renderKpis(rows, generatedAt) {
    var acao = rows.filter(function (r) { return r.tier === "acao"; }).length;
    var atencao = rows.filter(function (r) { return r.tier === "atencao"; }).length;
    var ok = rows.filter(function (r) { return r.tier === "ok"; }).length;
    var totalArea = rows.reduce(function (s, r) { return s + r.totalArea; }, 0);

    document.getElementById("kpiTotal").textContent = rows.length;
    document.getElementById("kpiArea").textContent = fmtArea(totalArea);
    document.getElementById("kpiAcao").textContent = acao;
    document.getElementById("kpiAtencao").textContent = atencao;
    document.getElementById("kpiOk").textContent = ok;
    document.getElementById("kpiUpdated").textContent = generatedAt || "—";
  }

  function renderTable() {
    var search = document.getElementById("dashSearch").value.trim().toLowerCase();
    var statusFilter = document.getElementById("dashStatusFilter").value;
    var tierOrder = { acao: 0, atencao: 1, ok: 2 };

    var filtered = allRows.filter(function (r) {
      if (statusFilter !== "all" && r.tier !== statusFilter) { return false; }
      if (!search) { return true; }
      var haystack = (r.pname + " " + (r.block || "")).toLowerCase();
      return haystack.indexOf(search) !== -1;
    });
    filtered.sort(function (a, b) {
      if (tierOrder[a.tier] !== tierOrder[b.tier]) { return tierOrder[a.tier] - tierOrder[b.tier]; }
      return b.trend - a.trend || 0;
    });

    var tbody = document.getElementById("dashTableBody");
    tbody.innerHTML = filtered.map(buildRowHtml).join("");
    document.getElementById("dashEmpty").hidden = filtered.length > 0;
    document.getElementById("dashTable").hidden = filtered.length === 0;
  }

  document.getElementById("dashSearch").addEventListener("input", renderTable);
  document.getElementById("dashStatusFilter").addEventListener("change", renderTable);
  document.getElementById("dashTableBody").addEventListener("click", function (e) {
    var row = e.target.closest(".dash-row");
    if (row) { window.location.href = row.getAttribute("data-href"); }
  });

  // ------------------------------------------------------------------
  // Configuracao do site (titulo/logos) -- mesmo padrao do app.js
  // ------------------------------------------------------------------
  fetch("../data/site.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) { return; }
      if (cfg.title) { document.getElementById("brandTitle").textContent = cfg.title; document.title = cfg.title + " — Dashboard"; }
      [["brandLogo1", cfg.logo1], ["brandLogo2", cfg.logo2]].forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el && pair[1]) { el.src = "../data/" + pair[1]; el.hidden = false; }
      });
    })
    .catch(function () { /* sem site.json -- mantem o texto fixo */ });

  fetch("../data/catalog.json")
    .then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    })
    .then(function (catalog) {
      allRows = buildRows(catalog);
      renderKpis(allRows, catalog.generatedAt);
      renderTable();
    })
    .catch(function (err) {
      document.getElementById("dashEmpty").hidden = false;
      document.getElementById("dashEmpty").textContent = "Falha ao carregar catálogo: " + err.message;
      document.getElementById("dashTable").hidden = true;
      console.error(err);
    });
})();
