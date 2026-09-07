(function () {
  "use strict";

  // Cores conhecidas, indexadas pelo NOME da classe (nao pelo numero
  // classe_id!). Projetos diferentes podem usar o MESMO classe_id pra
  // significados diferentes (ex: id=4 e' "Poda Seletiva" na SE-T3 mas
  // "Painel/Estrutura" numa usina solar) -- indexar por id causava a legenda
  // de um projeto vazar/confundir com a de outro. Uma classe cujo nome nao
  // esteja aqui ganha uma cor gerada automaticamente da FALLBACK_PALETTE.
  var KNOWN_COLORS_BY_NAME = {
    "Solo": "#8B5E34",
    "Roço (até 0,40 m)": "#F4B400",
    "Poda Leve (0,40 m a 3,00 m)": "#FF8C42",
    "Poda Seletiva (3,00 m a 8,00 m)": "#E63946",
    "Não Identificado": "#9AA0A6"
  };
  var FALLBACK_PALETTE = ["#2A9D8F", "#264653", "#E76F51", "#457B9D", "#8AC926", "#B5179E"];
  var DEFAULT_OPACITY = 55; // % (vegetacao)

  // Paleta de cores basicas pra acesso rapido (alem do seletor de cor
  // completo) -- pedido explicito do usuario pra nao precisar abrir o color
  // picker so' pra achar um verde/vermelho/amarelo comuns.
  var BASIC_COLOR_PALETTE = ["#2ECC71", "#F1C40F", "#E67E22", "#E74C3C", "#8B5E34", "#3498DB", "#9B59B6", "#7F8C8D"];

  // Por padrao, classes de estrutura (paineis solares etc.) nao entram no
  // grafico de % vegetacao/solo -- mas o usuario pode religar por classe no
  // checkbox "grafico" de cada linha da legenda.
  function defaultChartIncluded(name) {
    return !/painel|estrutura/i.test(name || "");
  }

  // ------------------------------------------------------------------
  // Mapa base
  // ------------------------------------------------------------------
  var map = L.map("map", {
    zoomControl: false,
    minZoom: 3,
    maxZoom: 22
  });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  map.setView([0, 0], 2); // vista generica ate o catalogo carregar e ajustar

  // pane dedicado com z-index alto: garante que as camadas do swipe sempre
  // desenham por cima das camadas normais dos projetos, nao importa a ordem
  // em que foram ligadas -- sem isso, uma camada de projeto ligada depois do
  // swipe podia cobrir tudo e a comparacao parecia "nao fazer nada".
  // Dois panes: A embaixo (nunca recortado), B em cima (recortado pelo
  // divisor). Cortar o PANE em si (em vez do container interno de cada
  // camada) funciona igual pra ortofoto (raster) e vegetacao (vetor/SVG) --
  // qualquer camada que for adicionada aqui no futuro tambem funciona sem
  // precisar de tratamento especial por tipo.
  map.createPane("swipePaneA");
  map.createPane("swipePaneB");
  map.getPane("swipePaneA").style.zIndex = 649;
  map.getPane("swipePaneB").style.zIndex = 650;

  // pane da regua/medicao -- z-index acima dos dois panes do swipe, pra dar
  // pra medir mesmo com a comparacao ativa sem a linha/poligono ficar
  // escondido atras dos tiles/vegetacao do swipe.
  map.createPane("measurePane");
  map.getPane("measurePane").style.zIndex = 700;

  // Em areas rurais o Esri World Imagery costuma nao ter imagem em zooms muito
  // altos e devolve um tile placeholder ("Map data not yet available") em vez
  // de erro. maxNativeZoom trava as requisicoes nesse teto e deixa o Leaflet
  // ampliar (com perda de nitidez, mas sem placeholder) a partir dali.
  var esriLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: 17, attribution: "Tiles &copy; Esri" }
  );
  var osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  var baseLayers = { esri: esriLayer, osm: osmLayer, none: null };
  var currentBase = null;

  function setBasemap(key) {
    if (currentBase) { map.removeLayer(currentBase); }
    var layer = baseLayers[key];
    currentBase = layer || null;
    if (currentBase) { currentBase.addTo(map); currentBase.bringToBack(); }
  }
  document.querySelectorAll('input[name="basemap"]').forEach(function (el) {
    el.addEventListener("change", function () { setBasemap(this.value); });
  });
  setBasemap("esri");

  // ------------------------------------------------------------------
  // Estado
  // ------------------------------------------------------------------
  // projects[pid] = { id, name, flights: [flightMeta,...], blocks: [nomes distintos, sem null] }
  var projects = {};
  var projectOrder = [];
  var allBounds = null;

  // legend[classId] = { name, color, opacity, visible }
  var legend = {};
  var legendOrder = [];

  // flightKey = pid + "::" + date + "::" + (block || "")
  var orthoByFlight = {};   // flightKey -> L.tileLayer
  var vegByFlight = {};     // flightKey -> { classId: L.geoJSON }
  var vegDataPromiseByFlight = {};
  var activeOrtho = {};     // flightKey -> true
  var activeVeg = {};       // flightKey -> true
  var blockSelectedDate = {}; // "pid::block" -> data escolhida (default: mais recente)

  var projectSelect = document.getElementById("projectSelect");
  var projectPanelBody = document.getElementById("projectPanelBody");
  var catalogStatus = document.getElementById("catalogStatus");
  var legendList = document.getElementById("legendList");
  var legendPanel = document.getElementById("legendPanel");
  var legendSelectAll = document.getElementById("legendSelectAll");

  function flightKey(pid, date, block) { return pid + "::" + date + "::" + (block || ""); }
  function pidFromFlightKey(fk) { return fk.split("::")[0]; }

  // chave da legenda = projeto + classe -- nunca so' a classe (ver
  // KNOWN_COLORS_BY_NAME acima pro motivo)
  function legKey(pid, cid) { return pid + "|" + cid; }
  function legKeyParts(lk) {
    var i = lk.lastIndexOf("|");
    return { pid: lk.substring(0, i), cid: Number(lk.substring(i + 1)) };
  }

  // Destaque visual da feicao clicada -- sem isso, todo poligono da mesma
  // classe tem a mesma cor e fica dificil ver o limite exato do que foi
  // medido no popup.
  var highlighted = { layer: null, style: null };
  function clearHighlight() {
    if (highlighted.layer) { highlighted.layer.setStyle(highlighted.style); }
    highlighted.layer = null;
    highlighted.style = null;
  }
  function highlightLayer(layer, baseStyle) {
    if (highlighted.layer === layer) { return; }
    clearHighlight();
    highlighted.layer = layer;
    highlighted.style = baseStyle;
    layer.setStyle({ color: "#ffffff", weight: 3, opacity: 1, fillColor: baseStyle.fillColor, fillOpacity: baseStyle.fillOpacity });
    if (layer.bringToFront) { layer.bringToFront(); }
  }
  // getStyle e' uma funcao (sem argumentos) que devolve o style atual da
  // classe -- assim o destaque restaura a cor/opacidade certa mesmo que o
  // usuario tenha mudado a legenda entre o clique e o fechamento do popup.
  // Usado tanto pela legenda global (main map) quanto pelas legendas
  // independentes de cada lado do swipe (ver swipeStyleForClass).
  function bindFeatureInteraction(layer, feature, getStyle) {
    layer.bindPopup(popupHtml(feature.properties));
    layer.on("click", function () { highlightLayer(layer, getStyle()); });
    layer.on("popupclose", function () { if (highlighted.layer === layer) { clearHighlight(); } });
  }

  function findFlight(pid, date, block) {
    var fls = projects[pid].flights;
    for (var i = 0; i < fls.length; i++) {
      if (fls[i].date === date && (fls[i].block || null) === (block || null)) { return fls[i]; }
    }
    return null;
  }

  function latestFlightForBlock(pid, block) {
    var fls = projects[pid].flights.filter(function (f) { return (f.block || null) === (block || null); });
    return fls[0] || null; // catalog.json ja vem ordenado por data desc
  }

  function datesForBlock(pid, block) {
    return projects[pid].flights
      .filter(function (f) { return (f.block || null) === (block || null); })
      .map(function (f) { return f.date; }); // ja vem ordenado desc
  }

  function selectedDateForBlock(pid, block) {
    var key = pid + "::" + block;
    if (blockSelectedDate[key]) { return blockSelectedDate[key]; }
    var dates = datesForBlock(pid, block);
    return dates[0]; // sem preferencia salva: usa a mais recente
  }

  // ------------------------------------------------------------------
  // Configuracao do site (titulo/subtitulo do cabecalho + ate 2 logos) --
  // opcional: se data/site.json nao existir (ou o fetch falhar), o texto
  // fixo que ja esta no index.html continua valendo, sem erro visivel.
  // ------------------------------------------------------------------
  fetch("../data/site.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) { return; }
      if (cfg.title) { document.getElementById("brandTitle").textContent = cfg.title; document.title = cfg.title; }
      if (cfg.subtitle) { document.getElementById("brandSub").textContent = cfg.subtitle; }
      [["brandLogo1", cfg.logo1], ["brandLogo2", cfg.logo2]].forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el && pair[1]) { el.src = "../data/" + pair[1]; el.hidden = false; }
      });
    })
    .catch(function () { /* sem site.json -- mantem o texto fixo do index.html */ });

  // ------------------------------------------------------------------
  // Carrega catalogo
  // ------------------------------------------------------------------
  fetch("../data/catalog.json")
    .then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    })
    .then(function (catalog) {
      var updatedEl = document.getElementById("dataUpdatedAt");
      if (updatedEl) { updatedEl.textContent = catalog.generatedAt || "—"; }
      var cat = catalog.projects || [];
      if (cat.length === 0) {
        catalogStatus.textContent = "Nenhum projeto no catálogo.";
        return;
      }
      cat.forEach(function (p) { registerProject(p); });
      buildLegendFromCatalog(cat);
      populateProjectSelect();
      populateSwipeSelects();
      catalogStatus.textContent = cat.length + " projeto(s) carregado(s).";
      if (allBounds) { map.fitBounds(allBounds); }

      // ativa automaticamente o primeiro item do primeiro projeto, pra a
      // pagina nao abrir vazia
      // se veio de um link do dashboard (?project=&date=&block=), ativa
      // direto aquele voo em vez do primeiro item do catalogo
      var params = new URLSearchParams(window.location.search);
      var qpProject = params.get("project");
      var qpDate = params.get("date");
      var qpBlock = params.get("block") || null;
      var target = qpProject && projects[qpProject] ? findFlight(qpProject, qpDate, qpBlock) : null;

      if (target) {
        setFlightActive(qpProject, target.date, target.block, true);
        renderProjectPanel(qpProject);
        if (target.bounds) { map.fitBounds(L.latLngBounds(target.bounds)); }
      } else {
        var first = cat[0];
        var firstFlight = first.flights[0];
        if (firstFlight) { setFlightActive(first.id, firstFlight.date, firstFlight.block, true); }
        renderProjectPanel(first.id);
      }
    })
    .catch(function (err) {
      catalogStatus.textContent = "Falha ao carregar catálogo: " + err.message;
      catalogStatus.style.color = "#c0392b";
      console.error(err);
    });

  function registerProject(p) {
    var blockSet = {};
    p.flights.forEach(function (fl) { if (fl.block) { blockSet[fl.block] = true; } });
    projects[p.id] = { id: p.id, name: p.name, flights: p.flights, blocks: Object.keys(blockSet) };
    projectOrder.push(p.id);
    p.flights.forEach(function (fl) { extendAllBounds(fl.bounds); });
  }

  function extendAllBounds(boundsArr) {
    var b = L.latLngBounds(boundsArr);
    allBounds = allBounds ? allBounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }

  // ------------------------------------------------------------------
  // Legenda global de vegetacao
  // ------------------------------------------------------------------
  function buildLegendFromCatalog(cat) {
    var fallbackIdx = 0;
    var groupsHtml = [];
    cat.forEach(function (p) {
      var classesSeen = {}; // cid -> nome
      p.flights.forEach(function (fl) {
        (fl.classes || []).forEach(function (c) { classesSeen[c.id] = classesSeen[c.id] || c.name; });
      });
      var cids = Object.keys(classesSeen).map(Number).sort(function (a, b) { return a - b; });
      if (cids.length === 0) { return; }

      var rowsHtml = cids.map(function (cid) {
        var name = classesSeen[cid];
        var lk = legKey(p.id, cid);
        var color = KNOWN_COLORS_BY_NAME[name] || FALLBACK_PALETTE[fallbackIdx++ % FALLBACK_PALETTE.length];
        legend[lk] = { name: name, color: color, opacity: DEFAULT_OPACITY, visible: true, chart: defaultChartIncluded(name) };
        legendOrder.push(lk);
        return buildLegendRowHtml(lk);
      }).join("");

      groupsHtml.push(
        '<div class="legend-project-group" data-project-group="' + p.id + '">' +
          '<div class="legend-project-title">' + escapeHtml(p.name) + '</div>' +
          rowsHtml +
        '</div>'
      );
    });

    legendList.innerHTML = groupsHtml.join("");
    updateLegendPanelVisibility();
    syncLegendSelectAll();
  }

  // A legenda geral fica escondida durante o swipe -- nesse modo ela nao
  // controla nada (cada lado tem sua propria legenda independente, ver
  // swipeLegend) e so' ocupa espaco/confunde.
  function updateLegendPanelVisibility() {
    legendPanel.hidden = swipeActive || legendOrder.length === 0;
  }

  // Garante que exista uma entrada de legenda pra (pid, cid); cria o grupo
  // do projeto na lista se ainda nao existir. Usado quando uma classe so' e'
  // descoberta depois (ex: geojson buscado sob demanda) em vez de no scan
  // inicial do catalogo.
  function ensureLegendEntry(pid, projectName, cid, name) {
    var lk = legKey(pid, cid);
    if (legend[lk]) { return lk; }
    var color = KNOWN_COLORS_BY_NAME[name] || FALLBACK_PALETTE[legendOrder.length % FALLBACK_PALETTE.length];
    legend[lk] = { name: name || ("Classe " + cid), color: color, opacity: DEFAULT_OPACITY, visible: true, chart: defaultChartIncluded(name) };
    legendOrder.push(lk);

    var group = legendList.querySelector('.legend-project-group[data-project-group="' + pid + '"]');
    if (!group) {
      legendList.insertAdjacentHTML("beforeend",
        '<div class="legend-project-group" data-project-group="' + pid + '">' +
          '<div class="legend-project-title">' + escapeHtml(projectName) + '</div>' +
        '</div>');
      group = legendList.querySelector('.legend-project-group[data-project-group="' + pid + '"]');
    }
    group.insertAdjacentHTML("beforeend", buildLegendRowHtml(lk));
    updateLegendPanelVisibility();
    syncLegendSelectAll();
    return lk;
  }

  function buildQuickColorsHtml(attrs) {
    return '<div class="quick-colors">' + BASIC_COLOR_PALETTE.map(function (c) {
      return '<button type="button" class="quick-color-swatch" style="background:' + c + '" data-quick-color="' + c + '" ' + attrs + '></button>';
    }).join("") + "</div>";
  }

  // Botao que so' mostra a cor atual; clicar abre um popover com a paleta
  // basica + o seletor de cor completo -- antes as 8 cores + o color picker
  // ficavam sempre expostos em toda linha, o que deixava a legenda com
  // "cara de aquarela". attrsKey identifica a linha (data-key ou
  // data-swipe-side/data-swipe-cid, dependendo de quem chama).
  function buildColorControlHtml(color, attrsKey) {
    return (
      '<button type="button" class="color-btn" style="background:' + color + '" data-role="legend-color-toggle" ' + attrsKey + ' title="Cor"></button>' +
      '<div class="color-popover" ' + attrsKey + ' hidden>' +
        buildQuickColorsHtml('data-role="legend-quickcolor" ' + attrsKey) +
        '<input type="color" class="color-swatch-full" value="' + color + '" data-role="legend-color" ' + attrsKey + '>' +
      '</div>'
    );
  }

  function buildLegendRowHtml(lk) {
    var st = legend[lk];
    return (
      '<div class="layer-card">' +
        '<div class="layer-card-head">' +
          '<input type="checkbox" checked data-role="legend-visible" data-key="' + lk + '" title="Mostrar no mapa">' +
          '<span class="layer-name">' + escapeHtml(st.name) + '</span>' +
          '<label class="chart-toggle" title="Incluir no gráfico de cobertura">' +
            '<input type="checkbox" ' + (st.chart ? "checked" : "") + ' data-role="legend-chart" data-key="' + lk + '">📊' +
          '</label>' +
          buildColorControlHtml(st.color, 'data-key="' + lk + '"') +
        '</div>' +
        '<div class="layer-card-body">' +
          '<span>opacidade</span>' +
          '<input type="range" min="0" max="100" value="' + st.opacity + '" data-role="legend-opacity" data-key="' + lk + '">' +
          '<span class="layer-opacity-val" data-role="legend-opacity-val" data-key="' + lk + '">' + st.opacity + '%</span>' +
        '</div>' +
      '</div>'
    );
  }

  // Fecha todos os popovers de cor abertos (main ou swipe), exceto o
  // passado em "except". Usado ao abrir um novo popover (so' um por vez) e
  // ao clicar fora de qualquer popover/botao de cor.
  function closeAllColorPopovers(except) {
    document.querySelectorAll(".color-popover").forEach(function (el) {
      if (el !== except) { el.hidden = true; }
    });
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest(".color-btn") || e.target.closest(".color-popover")) { return; }
    closeAllColorPopovers(null);
  });
  function toggleColorPopover(btn) {
    var card = btn.closest(".layer-card");
    var pop = card ? card.querySelector(".color-popover") : null;
    if (!pop) { return; }
    var willOpen = pop.hidden;
    closeAllColorPopovers(null);
    pop.hidden = !willOpen;
  }

  function styleForClass(lk) {
    var st = legend[lk];
    return { color: st.color, weight: 1, opacity: 0.9, fillColor: st.color, fillOpacity: st.opacity / 100 };
  }

  function setLegendColorUI(lk, color) {
    var btn = legendList.querySelector('.color-btn[data-key="' + lk + '"]');
    if (btn) { btn.style.background = color; }
    var full = legendList.querySelector('.color-swatch-full[data-key="' + lk + '"]');
    if (full) { full.value = color; }
  }

  function syncLegendSelectAll() {
    if (!legendSelectAll || legendOrder.length === 0) { return; }
    legendSelectAll.checked = legendOrder.every(function (lk) { return legend[lk].visible; });
  }

  legendList.addEventListener("change", function (e) {
    var role = e.target.getAttribute("data-role");
    var lk = e.target.getAttribute("data-key");
    if (!role || !lk) { return; }
    if (role === "legend-visible") {
      legend[lk].visible = e.target.checked;
      applyClassVisibilityEverywhere(lk);
      syncLegendSelectAll();
      renderChartPanel();
    } else if (role === "legend-color") {
      legend[lk].color = e.target.value;
      setLegendColorUI(lk, e.target.value);
      applyClassStyleEverywhere(lk);
      renderChartPanel();
      closeAllColorPopovers(null);
    } else if (role === "legend-chart") {
      legend[lk].chart = e.target.checked;
      renderChartPanel();
    }
  });
  legendList.addEventListener("input", function (e) {
    if (e.target.getAttribute("data-role") !== "legend-opacity") { return; }
    var lk = e.target.getAttribute("data-key");
    var v = Number(e.target.value);
    legend[lk].opacity = v;
    document.querySelector('[data-role="legend-opacity-val"][data-key="' + lk + '"]').textContent = v + "%";
    applyClassStyleEverywhere(lk);
  });
  legendList.addEventListener("click", function (e) {
    var colorBtn = e.target.closest(".color-btn");
    if (colorBtn) { toggleColorPopover(colorBtn); return; }
    var quickBtn = e.target.closest(".quick-color-swatch");
    if (quickBtn) {
      var lk = quickBtn.getAttribute("data-key");
      var color = quickBtn.getAttribute("data-quick-color");
      legend[lk].color = color;
      setLegendColorUI(lk, color);
      applyClassStyleEverywhere(lk);
      renderChartPanel();
      closeAllColorPopovers(null);
    }
  });
  if (legendSelectAll) {
    legendSelectAll.addEventListener("change", function () {
      var turnOn = this.checked;
      legendOrder.forEach(function (lk) {
        legend[lk].visible = turnOn;
        var cb = legendList.querySelector('[data-role="legend-visible"][data-key="' + lk + '"]');
        if (cb) { cb.checked = turnOn; }
        applyClassVisibilityEverywhere(lk);
      });
      renderChartPanel();
    });
  }
  document.getElementById("btnResetColors").addEventListener("click", function () {
    legendOrder.forEach(function (lk) {
      var st = legend[lk];
      var known = KNOWN_COLORS_BY_NAME[st.name];
      if (!known) { return; } // classe sem cor "oficial" conhecida fica como esta
      st.color = known;
      st.opacity = DEFAULT_OPACITY;
      setLegendColorUI(lk, known);
      var op = document.querySelector('[data-role="legend-opacity"][data-key="' + lk + '"]');
      if (op) { op.value = DEFAULT_OPACITY; }
      document.querySelector('[data-role="legend-opacity-val"][data-key="' + lk + '"]').textContent = DEFAULT_OPACITY + "%";
      applyClassStyleEverywhere(lk);
    });
    renderChartPanel();
  });

  function applyClassStyleEverywhere(lk) {
    var pid = legKeyParts(lk).pid, cid = legKeyParts(lk).cid;
    Object.keys(vegByFlight).forEach(function (fk) {
      if (pidFromFlightKey(fk) !== pid) { return; }
      var g = vegByFlight[fk][cid];
      if (g) { g.setStyle(styleForClass(lk)); }
    });
  }
  function applyClassVisibilityEverywhere(lk) {
    var pid = legKeyParts(lk).pid, cid = legKeyParts(lk).cid;
    Object.keys(vegByFlight).forEach(function (fk) {
      if (pidFromFlightKey(fk) !== pid) { return; }
      if (!activeVeg[fk]) { return; }
      var g = vegByFlight[fk][cid];
      if (!g) { return; }
      if (legend[lk].visible && !map.hasLayer(g)) { map.addLayer(g); }
      if (!legend[lk].visible && map.hasLayer(g)) { map.removeLayer(g); }
    });
  }

  // ------------------------------------------------------------------
  // Grafico de cobertura (% vegetacao/solo) -- so' fora do modo swipe. Usa
  // as estatisticas ja calculadas no build (fl.classes: count/areaM2 por
  // classe), nao precisa esperar o geojson terminar de carregar. Reage a
  // qualquer mudanca na legenda (visibilidade, cor, toggle "grafico") e a
  // qualquer ativacao/desativacao de vegetacao de um voo.
  // ------------------------------------------------------------------
  var chartViewMode = "donut"; // "donut" | "pie" | "bar"
  var chartPanel = document.getElementById("chartPanel");
  var chartList = document.getElementById("chartList");
  var chartTypeSelect = document.getElementById("chartTypeSelect");

  function chartDataForFlight(pid, fl) {
    var rows = (fl.classes || []).map(function (c) {
      var lk = legKey(pid, c.id);
      var st = legend[lk];
      if (!st || !st.chart || !st.visible) { return null; }
      return { name: st.name, color: st.color, areaM2: c.areaM2 };
    }).filter(Boolean);
    var total = rows.reduce(function (s, r) { return s + r.areaM2; }, 0);
    return { rows: rows, total: total };
  }

  function buildDonutHtml(data, isPie) {
    if (data.total <= 0) { return '<div class="chart-empty">sem dados visiveis</div>'; }
    var acc = 0;
    var stops = data.rows.map(function (r) {
      var pct = r.areaM2 / data.total * 100;
      var start = acc;
      acc += pct;
      return r.color + " " + start.toFixed(2) + "% " + acc.toFixed(2) + "%";
    }).join(", ");
    var cls = isPie ? "chart-donut chart-pie" : "chart-donut";
    return '<div class="' + cls + '" style="background: conic-gradient(' + stops + ')"></div>';
  }

  function buildBarHtml(data) {
    if (data.total <= 0) { return '<div class="chart-empty">sem dados visiveis</div>'; }
    var segs = data.rows.map(function (r) {
      var pct = r.areaM2 / data.total * 100;
      return '<div class="chart-bar-seg" style="width:' + pct.toFixed(2) + '%; background:' + r.color + '" title="' +
        escapeHtml(r.name) + ": " + pct.toFixed(1) + '%"></div>';
    }).join("");
    return '<div class="chart-bar">' + segs + "</div>";
  }

  function buildChartCardHtml(pid, fl, data) {
    var title = projects[pid].name + (fl.block ? " / " + fl.block : "") + " — " + fmtDate(fl.date);
    var vizHtml = chartViewMode === "bar" ? buildBarHtml(data) : buildDonutHtml(data, chartViewMode === "pie");
    var legendRows = data.rows.map(function (r) {
      var pct = data.total > 0 ? (r.areaM2 / data.total * 100) : 0;
      return (
        '<div class="chart-legend-row">' +
          '<span class="chart-swatch" style="background:' + r.color + '"></span>' +
          '<span class="chart-legend-name">' + escapeHtml(r.name) + "</span>" +
          '<span class="chart-legend-pct">' + pct.toFixed(1) + "%</span>" +
        "</div>"
      );
    }).join("");
    return (
      '<div class="chart-card">' +
        '<div class="chart-card-title">' + escapeHtml(title) + "</div>" +
        vizHtml +
        '<div class="chart-legend">' + legendRows + "</div>" +
      "</div>"
    );
  }

  function renderChartPanel() {
    if (!chartPanel || !chartList) { return; }
    if (swipeActive) { chartPanel.hidden = true; return; }
    var cards = [];
    projectOrder.forEach(function (pid) {
      projects[pid].flights.forEach(function (fl) {
        var key = flightKey(pid, fl.date, fl.block);
        if (!fl.hasVegetation || !activeVeg[key]) { return; }
        var data = chartDataForFlight(pid, fl);
        if (data.rows.length === 0) { return; }
        cards.push(buildChartCardHtml(pid, fl, data));
      });
    });
    if (cards.length === 0) {
      chartPanel.hidden = true;
      chartList.innerHTML = "";
      return;
    }
    chartPanel.hidden = false;
    chartList.innerHTML = cards.join("");
  }

  if (chartTypeSelect) {
    chartTypeSelect.value = chartViewMode;
    chartTypeSelect.addEventListener("change", function () {
      chartViewMode = this.value;
      renderChartPanel();
    });
  }

  // ------------------------------------------------------------------
  // Ativacao/desativacao de um item (projeto + data + bloco)
  // ------------------------------------------------------------------
  function setFlightActive(pid, date, block, active) {
    var fl = findFlight(pid, date, block);
    if (!fl) { return; }
    var key = flightKey(pid, date, block);

    if (fl.hasOrtho) { setOrthoActive(pid, fl, key, active); }
    if (fl.hasVegetation) { setVegActive(pid, fl, key, active); }
  }

  function setOrthoActive(pid, fl, key, active) {
    activeOrtho[key] = active;
    if (active) {
      if (!orthoByFlight[key]) {
        orthoByFlight[key] = L.tileLayer(
          "../data/" + fl.tiles + "/{z}/{x}/{y}." + fl.tileExt,
          {
            minZoom: 3, maxZoom: 22,
            maxNativeZoom: fl.maxNativeZoom, minNativeZoom: fl.minNativeZoom,
            bounds: fl.bounds, attribution: "Ortofoto local — " + projects[pid].name,
            // evita o "fantasma" de tile esticado via CSS que fica colado na
            // tela quando o zoom para em areas com muitos tiles (ex: usinas
            // solares) -- espera os tiles reais em vez de mostrar preview
            updateWhenZooming: false, updateWhenIdle: true
          }
        );
      }
      orthoByFlight[key].addTo(map);
    } else if (orthoByFlight[key] && map.hasLayer(orthoByFlight[key])) {
      map.removeLayer(orthoByFlight[key]);
    }
  }

  function setVegActive(pid, fl, key, active) {
    activeVeg[key] = active;
    renderChartPanel();
    if (!active) {
      var groups = vegByFlight[key];
      if (groups) {
        Object.keys(groups).forEach(function (cid) {
          if (map.hasLayer(groups[cid])) { map.removeLayer(groups[cid]); }
        });
      }
      return;
    }

    if (vegByFlight[key]) {
      Object.keys(vegByFlight[key]).forEach(function (cid) {
        var lk = legKey(pid, cid);
        if (legend[lk] && legend[lk].visible) { map.addLayer(vegByFlight[key][cid]); }
      });
      return;
    }

    if (vegDataPromiseByFlight[key]) { return; } // ja esta buscando

    vegDataPromiseByFlight[key] = fetch("../data/" + fl.vegetation)
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
      })
      .then(function (fc) {
        var byClass = {};
        fc.features.forEach(function (feat) {
          var cid = feat.properties.classe_id;
          (byClass[cid] = byClass[cid] || []).push(feat);
        });

        var groups = {};
        Object.keys(byClass).forEach(function (cidStr) {
          var cid = Number(cidStr);
          var feats = byClass[cidStr];
          var name = (feats[0] && feats[0].properties.classe_nome) || null;
          var lk = ensureLegendEntry(pid, projects[pid].name, cid, name);
          var group = L.geoJSON({ type: "FeatureCollection", features: feats }, {
            style: styleForClass(lk),
            onEachFeature: function (feature, layer) { bindFeatureInteraction(layer, feature, function () { return styleForClass(lk); }); }
          });
          groups[cid] = group;
          if (legend[lk].visible && activeVeg[key]) { group.addTo(map); }
        });
        vegByFlight[key] = groups;
      })
      .catch(function (err) {
        console.error("Falha ao carregar vegetacao de " + key, err);
        delete vegDataPromiseByFlight[key];
      });
  }

  function popupHtml(props) {
    return (
      "<b>" + (props.classe_nome || "—") + "</b><br>" +
      "Rótulo: " + (props.rotulo || "N/D") + "<br>" +
      "Área: " + fmtArea(Number(props.area_m2) || 0)
    );
  }

  // ------------------------------------------------------------------
  // Seletor de projeto + painel (blocos OU voo simples)
  // ------------------------------------------------------------------
  function populateProjectSelect() {
    projectSelect.innerHTML = projectOrder.map(function (pid) {
      return '<option value="' + pid + '">' + escapeHtml(projects[pid].name) + "</option>";
    }).join("");
  }
  projectSelect.addEventListener("change", function () { renderProjectPanel(this.value); });

  function renderProjectPanel(pid) {
    var proj = projects[pid];
    if (!proj) { projectPanelBody.innerHTML = ""; return; }
    projectSelect.value = pid;
    projectSelect.title = proj.name;

    if (proj.blocks.length > 0) {
      renderBlocksPanel(proj);
    } else {
      renderSimplePanel(proj);
    }
  }

  function renderBlocksPanel(proj) {
    var rows = proj.blocks.map(function (block) {
      var dates = datesForBlock(proj.id, block);
      var selDate = selectedDateForBlock(proj.id, block);
      var fl = findFlight(proj.id, selDate, block);
      var key = flightKey(proj.id, selDate, block);
      var orthoOn = !!activeOrtho[key];
      var vegOn = !!activeVeg[key];

      var dateSelect = "";
      if (dates.length > 1) {
        var opts = dates.map(function (d) {
          return '<option value="' + d + '"' + (d === selDate ? " selected" : "") + ">" + fmtDate(d) + "</option>";
        }).join("");
        dateSelect = '<select class="block-date-select" data-block="' + escapeHtml(block) + '">' + opts + "</select>";
      }

      var orthoBtn = fl.hasOrtho
        ? '<button type="button" class="mini-toggle mini-toggle-ortho' + (orthoOn ? " active" : "") + '" ' +
            'data-block="' + escapeHtml(block) + '" data-kind="ortho" title="Ortofoto">Foto</button>'
        : "";
      var vegBtn = fl.hasVegetation
        ? '<button type="button" class="mini-toggle mini-toggle-veg' + (vegOn ? " active" : "") + '" ' +
            'data-block="' + escapeHtml(block) + '" data-kind="veg" title="Vegetação">Veg</button>'
        : "";

      return (
        '<div class="block-row">' +
          '<span class="block-name" title="' + fmtDate(selDate) + '">' + escapeHtml(block) + "</span>" +
          orthoBtn + vegBtn +
          dateSelect +
        "</div>"
      );
    }).join("");

    projectPanelBody.innerHTML =
      '<div class="blocks-head">' +
        '<label class="select-all-row"><input type="checkbox" id="blocksSelectAll" ' +
          (countActiveBlocks(proj) === proj.blocks.length ? "checked" : "") + '> Selecionar todos</label>' +
        '<span class="blocks-count" id="blocksCount">' + countActiveBlocks(proj) + " selecionado(s)</span>" +
      "</div>" +
      '<div class="blocks-grid" id="blocksGrid">' + rows + "</div>";

    var grid = document.getElementById("blocksGrid");

    grid.addEventListener("click", function (e) {
      var btn = e.target.closest(".mini-toggle");
      if (!btn) { return; }
      var block = btn.getAttribute("data-block");
      var kind = btn.getAttribute("data-kind");
      var date = selectedDateForBlock(proj.id, block);
      var fl = findFlight(proj.id, date, block);
      var key = flightKey(proj.id, date, block);

      if (kind === "ortho") {
        setOrthoActive(proj.id, fl, key, !activeOrtho[key]);
      } else {
        setVegActive(proj.id, fl, key, !activeVeg[key]);
      }
      btn.classList.toggle("active");
      document.getElementById("blocksCount").textContent = countActiveBlocks(proj) + " selecionado(s)";
      document.getElementById("blocksSelectAll").checked = countActiveBlocks(proj) === proj.blocks.length;
    });

    grid.addEventListener("change", function (e) {
      var sel = e.target.closest(".block-date-select");
      if (!sel) { return; }
      var block = sel.getAttribute("data-block");
      var oldDate = selectedDateForBlock(proj.id, block);
      var newDate = sel.value;
      var oldKey = flightKey(proj.id, oldDate, block);
      var wasOrtho = !!activeOrtho[oldKey];
      var wasVeg = !!activeVeg[oldKey];

      blockSelectedDate[proj.id + "::" + block] = newDate;

      var oldFl = findFlight(proj.id, oldDate, block);
      var newFl = findFlight(proj.id, newDate, block);
      var newKey = flightKey(proj.id, newDate, block);
      if (wasOrtho) { setOrthoActive(proj.id, oldFl, oldKey, false); setOrthoActive(proj.id, newFl, newKey, true); }
      if (wasVeg) { setVegActive(proj.id, oldFl, oldKey, false); setVegActive(proj.id, newFl, newKey, true); }

      renderBlocksPanel(proj); // re-renderiza pra refletir os toggles/botoes disponiveis na nova data
    });

    document.getElementById("blocksSelectAll").addEventListener("change", function () {
      var turnOn = this.checked;
      proj.blocks.forEach(function (block) {
        var date = selectedDateForBlock(proj.id, block);
        setFlightActive(proj.id, date, block, turnOn);
      });
      renderBlocksPanel(proj); // re-renderiza os botoes com o novo estado
    });
  }

  function countActiveBlocks(proj) {
    return proj.blocks.filter(function (block) {
      var date = selectedDateForBlock(proj.id, block);
      var key = flightKey(proj.id, date, block);
      return !!activeOrtho[key] || !!activeVeg[key];
    }).length;
  }

  function renderSimplePanel(proj) {
    var dates = proj.flights.map(function (f) { return f.date; });
    var currentDate = dates[0];
    var activeDate = proj.flights.filter(function (f) {
      var k = flightKey(proj.id, f.date, null);
      return activeOrtho[k] || activeVeg[k];
    })[0];
    if (activeDate) { currentDate = activeDate.date; }

    var fl = findFlight(proj.id, currentDate, null);
    var key = flightKey(proj.id, currentDate, null);
    var orthoOn = !!activeOrtho[key];
    var vegOn = !!activeVeg[key];

    var options = dates.map(function (d) {
      return '<option value="' + d + '"' + (d === currentDate ? " selected" : "") + ">" + fmtDate(d) + "</option>";
    }).join("");

    var orthoRow = fl.hasOrtho
      ? '<label><input type="checkbox" id="simpleOrtho" ' + (orthoOn ? "checked" : "") + "> Ortofoto</label>"
      : "";
    var vegRow = fl.hasVegetation
      ? '<label><input type="checkbox" id="simpleVeg" ' + (vegOn ? "checked" : "") + "> Vegetação</label>"
      : "";

    projectPanelBody.innerHTML =
      '<div class="simple-row">' + orthoRow + vegRow +
        '<select id="simpleDate">' + options + "</select>" +
      "</div>";

    var orthoCb = document.getElementById("simpleOrtho");
    if (orthoCb) {
      orthoCb.addEventListener("change", function () { setOrthoActive(proj.id, fl, key, this.checked); });
    }
    var vegCb = document.getElementById("simpleVeg");
    if (vegCb) {
      vegCb.addEventListener("change", function () { setVegActive(proj.id, fl, key, this.checked); });
    }
    document.getElementById("simpleDate").addEventListener("change", function () {
      var newDate = this.value;
      var newFl = findFlight(proj.id, newDate, null);
      var newKey = flightKey(proj.id, newDate, null);
      if (orthoOn) { setOrthoActive(proj.id, fl, key, false); setOrthoActive(proj.id, newFl, newKey, true); }
      if (vegOn) { setVegActive(proj.id, fl, key, false); setVegActive(proj.id, newFl, newKey, true); }
      renderSimplePanel(proj);
    });
  }

  function fmtDate(iso) {
    var parts = iso.split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : iso;
  }
  function fmtArea(m2) {
    return m2 >= 10000 ? (m2 / 10000).toFixed(2) + " ha" : m2.toFixed(0) + " m²";
  }
  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ------------------------------------------------------------------
  // Comparar Camadas (swipe) -- ortofoto ou vegetacao, qualquer combinacao
  // ------------------------------------------------------------------
  var swipeSelectA = document.getElementById("swipeA");
  var swipeSelectB = document.getElementById("swipeB");
  var btnSwipeToggle = document.getElementById("btnSwipeToggle");
  var swipeActive = false;
  var swipeCurrentPct = 50;
  // cada lado e' um array de { cid, layer } -- cid e' null pra ortofoto
  // (sempre visivel) ou o classe_id pra vegetacao.
  var swipeLayers = { a: null, b: null };
  // Legenda INDEPENDENTE de cada lado do swipe (nao e' a legenda global
  // "legend" usada pelo mapa normal) -- assim da' pra comparar, por exemplo,
  // "Vegetacao Baixa" do lado A com "Vegetacao Alta" do lado B sem uma
  // interferir na outra. side -> { cid: {name, color, opacity, visible} }
  var swipeLegend = { a: {}, b: {} };
  var swipeDom = { divider: null, handle: null, labelA: null, labelB: null };

  function populateSwipeSelects() {
    var opts = [];
    projectOrder.forEach(function (pid) {
      projects[pid].flights.forEach(function (fl) {
        var base = pid + "|" + fl.date + "|" + (fl.block || "");
        var label = projects[pid].name + (fl.block ? " / " + fl.block : "") + " — " + fmtDate(fl.date);
        if (fl.hasOrtho) { opts.push('<option value="' + base + '|ortho">' + escapeHtml(label) + " (Ortofoto)</option>"); }
        if (fl.hasVegetation) { opts.push('<option value="' + base + '|veg">' + escapeHtml(label) + " (Vegetação)</option>"); }
      });
    });
    swipeSelectA.innerHTML = opts.join("");
    swipeSelectB.innerHTML = opts.join("");
    if (opts.length > 1) { swipeSelectB.selectedIndex = 1; }
    document.getElementById("swipePanel").hidden = opts.length === 0;
    updateSwipeSelectTitle(swipeSelectA);
    updateSwipeSelectTitle(swipeSelectB);
  }

  // O texto do <select> fica truncado com reticencias quando mais largo que
  // a barra lateral (ver .swipe-row select no CSS) -- o title mostra o
  // rotulo completo ao passar o mouse.
  function updateSwipeSelectTitle(sel) {
    var opt = sel.options[sel.selectedIndex];
    sel.title = opt ? opt.text : "";
  }
  swipeSelectA.addEventListener("change", function () { updateSwipeSelectTitle(swipeSelectA); });
  swipeSelectB.addEventListener("change", function () { updateSwipeSelectTitle(swipeSelectB); });

  function flightFromSelectValue(val) {
    var parts = val.split("|");
    var pid = parts[0], date = parts[1], block = parts[2] || null, type = parts[3];
    return { pid: pid, date: date, block: block, type: type, meta: findFlight(pid, date, block), name: projects[pid].name };
  }

  function swipeSideLabel(info) {
    return info.name + (info.block ? " / " + info.block : "") + " — " + fmtDate(info.date) +
      (info.type === "veg" ? " (Vegetação)" : " (Ortofoto)");
  }

  function swipeStyleForClass(side, cid) {
    var st = swipeLegend[side][cid];
    return { color: st.color, weight: 1, opacity: 0.9, fillColor: st.color, fillOpacity: st.opacity / 100 };
  }

  // Constroi a(s) layer(s) de um lado do swipe e (pra vegetacao) preenche a
  // legenda independente daquele lado (swipeLegend[side]). Pane em si e' o
  // que sera' recortado (ver setSwipePosition) -- funciona igual pra tile
  // layer (ortofoto) ou grupos L.geoJSON (vegetacao).
  function buildSwipeLayers(info, paneName, side) {
    if (info.type === "ortho") {
      return Promise.resolve([
        { cid: null, layer: L.tileLayer("../data/" + info.meta.tiles + "/{z}/{x}/{y}." + info.meta.tileExt, {
          maxZoom: 22, maxNativeZoom: info.meta.maxNativeZoom, minNativeZoom: info.meta.minNativeZoom,
          bounds: info.meta.bounds, updateWhenZooming: false, updateWhenIdle: true, pane: paneName
        }) }
      ]);
    }
    return fetch("../data/" + info.meta.vegetation)
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
      })
      .then(function (fc) {
        var byClass = {};
        fc.features.forEach(function (feat) {
          var cid = feat.properties.classe_id;
          (byClass[cid] = byClass[cid] || []).push(feat);
        });
        swipeLegend[side] = {};
        var fallbackIdx = 0;
        return Object.keys(byClass).map(function (cidStr) {
          var cid = Number(cidStr);
          var feats = byClass[cidStr];
          var name = (feats[0] && feats[0].properties.classe_nome) || ("Classe " + cid);
          var color = KNOWN_COLORS_BY_NAME[name] || FALLBACK_PALETTE[fallbackIdx++ % FALLBACK_PALETTE.length];
          swipeLegend[side][cid] = { name: name, color: color, opacity: DEFAULT_OPACITY, visible: true };
          var layer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
            pane: paneName,
            style: swipeStyleForClass(side, cid),
            onEachFeature: function (feature, layer) {
              bindFeatureInteraction(layer, feature, function () { return swipeStyleForClass(side, cid); });
            }
          });
          return { cid: cid, layer: layer };
        });
      });
  }

  function isSwipeItemVisible(side, item) {
    return item.cid === null || (swipeLegend[side][item.cid] && swipeLegend[side][item.cid].visible);
  }

  function findSwipeItem(side, cid) {
    var items = swipeLayers[side] || [];
    for (var i = 0; i < items.length; i++) { if (items[i].cid === cid) { return items[i]; } }
    return null;
  }

  function renderSwipeSideLegend(side, info) {
    var container = document.getElementById(side === "a" ? "swipeLegendA" : "swipeLegendB");
    if (!container) { return; }
    container.className = "swipe-legend swipe-legend-" + side;
    var cids = Object.keys(swipeLegend[side]).map(Number).sort(function (x, y) { return x - y; });
    if (info.type !== "veg" || cids.length === 0) {
      container.innerHTML = "";
      container.hidden = true;
      return;
    }
    container.hidden = false;
    var title = (info.block ? escapeHtml(info.block) + " · " : "") + "Vegetação " + fmtDate(info.date);
    container.innerHTML =
      '<div class="swipe-legend-title"><span class="swipe-legend-badge">' + side.toUpperCase() + "</span><span>" + title + "</span></div>" +
      cids.map(function (cid) { return buildSwipeLegendRowHtml(side, cid); }).join("");
  }

  function buildSwipeLegendRowHtml(side, cid) {
    var st = swipeLegend[side][cid];
    var attrsKey = 'data-swipe-side="' + side + '" data-swipe-cid="' + cid + '"';
    return (
      '<div class="layer-card">' +
        '<div class="layer-card-head">' +
          '<input type="checkbox" checked data-role="legend-visible" ' + attrsKey + '>' +
          '<span class="layer-name">' + escapeHtml(st.name) + "</span>" +
          buildColorControlHtml(st.color, attrsKey) +
        "</div>" +
        '<div class="layer-card-body">' +
          "<span>opacidade</span>" +
          '<input type="range" min="0" max="100" value="' + st.opacity + '" data-role="legend-opacity" ' + attrsKey + '>' +
          '<span class="layer-opacity-val" data-role="legend-opacity-val" ' + attrsKey + '>' + st.opacity + "%</span>" +
        "</div>" +
      "</div>"
    );
  }

  function applySwipeVisibility(side, cid) {
    var it = findSwipeItem(side, cid);
    if (!it) { return; }
    var visible = swipeLegend[side][cid].visible;
    if (visible && !map.hasLayer(it.layer)) { map.addLayer(it.layer); }
    if (!visible && map.hasLayer(it.layer)) { map.removeLayer(it.layer); }
  }
  function applySwipeStyle(side, cid) {
    var it = findSwipeItem(side, cid);
    if (it) { it.layer.setStyle(swipeStyleForClass(side, cid)); }
  }

  ["a", "b"].forEach(function (side) {
    var container = document.getElementById(side === "a" ? "swipeLegendA" : "swipeLegendB");
    if (!container) { return; }
    container.addEventListener("change", function (e) {
      var role = e.target.getAttribute("data-role");
      var cid = Number(e.target.getAttribute("data-swipe-cid"));
      if (!role || !swipeLegend[side][cid]) { return; }
      if (role === "legend-visible") {
        swipeLegend[side][cid].visible = e.target.checked;
        applySwipeVisibility(side, cid);
      } else if (role === "legend-color") {
        swipeLegend[side][cid].color = e.target.value;
        setSwipeColorUI(container, cid, e.target.value);
        applySwipeStyle(side, cid);
        closeAllColorPopovers(null);
      }
    });
    container.addEventListener("input", function (e) {
      if (e.target.getAttribute("data-role") !== "legend-opacity") { return; }
      var cid = Number(e.target.getAttribute("data-swipe-cid"));
      if (!swipeLegend[side][cid]) { return; }
      var v = Number(e.target.value);
      swipeLegend[side][cid].opacity = v;
      var valEl = container.querySelector('[data-role="legend-opacity-val"][data-swipe-cid="' + cid + '"]');
      if (valEl) { valEl.textContent = v + "%"; }
      applySwipeStyle(side, cid);
    });
    container.addEventListener("click", function (e) {
      var colorBtn = e.target.closest(".color-btn");
      if (colorBtn) { toggleColorPopover(colorBtn); return; }
      var quickBtn = e.target.closest(".quick-color-swatch");
      if (quickBtn) {
        var cid = Number(quickBtn.getAttribute("data-swipe-cid"));
        if (!swipeLegend[side][cid]) { return; }
        var color = quickBtn.getAttribute("data-quick-color");
        swipeLegend[side][cid].color = color;
        setSwipeColorUI(container, cid, color);
        applySwipeStyle(side, cid);
        closeAllColorPopovers(null);
      }
    });
  });

  function setSwipeColorUI(container, cid, color) {
    var btn = container.querySelector('.color-btn[data-swipe-cid="' + cid + '"]');
    if (btn) { btn.style.background = color; }
    var full = container.querySelector('.color-swatch-full[data-swipe-cid="' + cid + '"]');
    if (full) { full.value = color; }
  }

  btnSwipeToggle.addEventListener("click", function () {
    if (swipeActive) { deactivateSwipe(); } else { activateSwipe(); }
  });

  function activateSwipe() {
    if (!swipeSelectA.value || !swipeSelectB.value) { return; }
    var a = flightFromSelectValue(swipeSelectA.value);
    var b = flightFromSelectValue(swipeSelectB.value);

    sizeSwipePanes();
    map.on("move zoom", onMapMoveDuringSwipe);

    var mapWrap = document.getElementById("mapWrap");
    swipeDom.divider = document.createElement("div");
    swipeDom.divider.className = "swipe-divider";
    swipeDom.handle = document.createElement("div");
    swipeDom.handle.className = "swipe-handle";
    swipeDom.handle.textContent = "↔";
    swipeDom.divider.appendChild(swipeDom.handle);

    swipeDom.labelA = document.createElement("div");
    swipeDom.labelA.className = "swipe-label left";
    swipeDom.labelA.textContent = "A: " + swipeSideLabel(a);
    swipeDom.labelA.title = swipeDom.labelA.textContent; // texto completo via tooltip nativo se truncar
    swipeDom.labelB = document.createElement("div");
    swipeDom.labelB.className = "swipe-label right";
    swipeDom.labelB.textContent = "B: " + swipeSideLabel(b);
    swipeDom.labelB.title = swipeDom.labelB.textContent;

    mapWrap.appendChild(swipeDom.divider);
    mapWrap.appendChild(swipeDom.labelA);
    mapWrap.appendChild(swipeDom.labelB);

    setSwipePosition(50);
    swipeDom.handle.addEventListener("mousedown", onSwipeDragStart);
    swipeDom.handle.addEventListener("touchstart", onSwipeDragStart, { passive: true });

    swipeActive = true;
    btnSwipeToggle.textContent = "Desativar comparação";
    btnSwipeToggle.classList.add("active");
    renderChartPanel(); // esconde o grafico -- nao faz sentido durante a comparacao
    updateLegendPanelVisibility(); // esconde a legenda geral -- cada lado tem a sua propria

    buildSwipeLayers(a, "swipePaneA", "a").then(function (items) {
      swipeLayers.a = items;
      renderSwipeSideLegend("a", a);
      if (swipeActive) {
        items.forEach(function (it) { if (isSwipeItemVisible("a", it)) { it.layer.addTo(map); } });
      }
    });
    buildSwipeLayers(b, "swipePaneB", "b").then(function (items) {
      swipeLayers.b = items;
      renderSwipeSideLegend("b", b);
      if (swipeActive) {
        items.forEach(function (it) { if (isSwipeItemVisible("b", it)) { it.layer.addTo(map); } });
      }
    });
  }

  function deactivateSwipe() {
    map.off("move zoom", onMapMoveDuringSwipe);
    (swipeLayers.a || []).forEach(function (it) { map.removeLayer(it.layer); });
    (swipeLayers.b || []).forEach(function (it) { map.removeLayer(it.layer); });
    swipeLayers.a = null;
    swipeLayers.b = null;
    swipeLegend.a = {};
    swipeLegend.b = {};
    ["swipeLegendA", "swipeLegendB"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.innerHTML = ""; el.hidden = true; }
    });
    ["divider", "labelA", "labelB"].forEach(function (k) {
      if (swipeDom[k] && swipeDom[k].parentNode) { swipeDom[k].parentNode.removeChild(swipeDom[k]); }
      swipeDom[k] = null;
    });
    swipeActive = false;
    swipeCurrentPct = 50;
    btnSwipeToggle.textContent = "Ativar comparação";
    btnSwipeToggle.classList.remove("active");
    renderChartPanel(); // volta a mostrar o grafico do estado normal do mapa
    updateLegendPanelVisibility(); // volta a mostrar a legenda geral
  }

  function onMapMoveDuringSwipe() { setSwipePosition(swipeCurrentPct); }

  function sizeSwipePanes() {
    var mapSize = map.getSize();
    ["swipePaneA", "swipePaneB"].forEach(function (name) {
      var pane = map.getPane(name);
      if (pane) { pane.style.width = mapSize.x + "px"; pane.style.height = mapSize.y + "px"; }
    });
  }

  function setSwipePosition(pct) {
    pct = Math.max(0, Math.min(100, pct));
    swipeCurrentPct = pct;
    if (!swipeDom.divider) { return; }
    swipeDom.divider.style.left = pct + "%";

    // Cortamos o PANE inteiro (nao o container interno de cada camada) --
    // um pane e' um <div> que criamos e dimensionamos nos mesmos (ver
    // sizeSwipePanes), entao nao tem o problema de caixa 0x0 que as tile
    // layers tem. Funciona igual pra raster (tiles) e vetor (SVG).
    //
    // O Leaflet desloca o pane via transform (pan/zoom) sem que a origem
    // local dele fique alinhada com a borda visivel do mapa -- por isso
    // medimos a posicao REAL na tela (getBoundingClientRect) de ambos a
    // cada chamada, em vez de assumir que os dois comecam no mesmo (0,0).
    var paneB = map.getPane("swipePaneB");
    if (paneB) {
      sizeSwipePanes();
      var mapRect = document.getElementById("map").getBoundingClientRect();
      var paneRect = paneB.getBoundingClientRect();
      var dividerScreenX = mapRect.left + (mapRect.width * pct / 100);
      var xPx = Math.round(dividerScreenX - paneRect.left);
      paneB.style.clipPath = "inset(0px 0px 0px " + xPx + "px)";
    }
  }

  function onSwipeDragStart(ev) {
    ev.preventDefault();
    document.addEventListener("mousemove", onSwipeDragMove);
    document.addEventListener("touchmove", onSwipeDragMove, { passive: false });
    document.addEventListener("mouseup", onSwipeDragEnd);
    document.addEventListener("touchend", onSwipeDragEnd);
  }
  function onSwipeDragMove(ev) {
    var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    var rect = document.getElementById("map").getBoundingClientRect();
    setSwipePosition(((clientX - rect.left) / rect.width) * 100);
    if (ev.cancelable) { ev.preventDefault(); }
  }
  function onSwipeDragEnd() {
    document.removeEventListener("mousemove", onSwipeDragMove);
    document.removeEventListener("touchmove", onSwipeDragMove);
    document.removeEventListener("mouseup", onSwipeDragEnd);
    document.removeEventListener("touchend", onSwipeDragEnd);
  }

  // ------------------------------------------------------------------
  // Medicao (regua) -- linha e area, so' visual, nada e' persistido em
  // lugar nenhum. Cada clique no mapa adiciona um vertice na forma atual;
  // duplo-clique termina essa forma (o proximo clique comeca uma nova).
  // Desenhada no pane "measurePane" (zIndex 700) pra ficar visivel mesmo
  // com o swipe ativo, que usa panes 649/650.
  // ------------------------------------------------------------------
  var measureLayer = L.layerGroup().addTo(map);
  var measureMode = null; // null | "line" | "area"
  var measureShapes = []; // cada forma (em andamento ou ja terminada) fica aqui
  var measureCurrentIdx = -1; // indice em measureShapes da forma sendo desenhada agora, ou -1
  var btnMeasureLine = document.getElementById("btnMeasureLine");
  var btnMeasureArea = document.getElementById("btnMeasureArea");
  var btnMeasureClear = document.getElementById("btnMeasureClear");

  function fmtDistanceMeasure(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + " km" : m.toFixed(0) + " m";
  }
  function fmtAreaMeasure(m2) {
    return m2 >= 10000 ? (m2 / 10000).toFixed(2) + " ha" : m2.toFixed(0) + " m²";
  }
  function polygonAreaM2(latlngs) {
    var pts = latlngs.map(function (ll) { return L.CRS.EPSG3857.project(ll); });
    var area = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(area) / 2;
  }
  function centroidLatLng(pts) {
    var lat = 0, lng = 0;
    pts.forEach(function (p) { lat += p.lat; lng += p.lng; });
    return L.latLng(lat / pts.length, lng / pts.length);
  }

  function setMeasureMode(mode) {
    if (measureMode === mode) { mode = null; } // clicar no mesmo botao desliga
    measureCurrentIdx = -1; // deixa a forma em andamento como esta -- so' para de estende-la
    measureMode = mode;
    btnMeasureLine.classList.toggle("active", mode === "line");
    btnMeasureArea.classList.toggle("active", mode === "area");
    map.doubleClickZoom[mode ? "disable" : "enable"]();
    map.getContainer().style.cursor = mode ? "crosshair" : "";
  }

  // Marcador arrastavel pra cada vertice -- se o usuario clicar no lugar
  // errado, da' pra corrigir arrastando em vez de ter que limpar e comecar
  // de novo. "index" e' a posicao fixa desse vertice dentro de rec.points
  // (o array so' cresce, nunca reordena, entao o indice nunca fica invalido).
  function addVertexMarker(rec, latlng, index) {
    var marker = L.marker(latlng, {
      pane: "measurePane", draggable: true,
      icon: L.divIcon({ className: "measure-vertex", iconSize: [14, 14], iconAnchor: [7, 7] })
    }).addTo(measureLayer);
    marker.on("drag", function (e) {
      rec.points[index] = e.target.getLatLng();
      redrawMeasureShape(rec);
    });
    rec.markers.push(marker);
  }

  function redrawMeasureShape(rec) {
    rec.shape.setLatLngs(rec.points);
    updateMeasureLabel(rec);
  }

  function startMeasureShape(mode, latlng) {
    var rec = { mode: mode, points: [latlng], markers: [], shape: null, label: null };
    rec.shape = mode === "area"
      ? L.polygon(rec.points, { pane: "measurePane", color: "#e63946", weight: 2, dashArray: "6 4", fillOpacity: 0.15 }).addTo(measureLayer)
      : L.polyline(rec.points, { pane: "measurePane", color: "#e63946", weight: 3, dashArray: "6 4" }).addTo(measureLayer);
    rec.label = L.tooltip(latlng, { pane: "measurePane", permanent: true, direction: "top", className: "measure-label" }).addTo(measureLayer);
    addVertexMarker(rec, latlng, 0);
    measureShapes.push(rec);
    measureCurrentIdx = measureShapes.length - 1;
    updateMeasureLabel(rec);
  }

  function addMeasurePoint(latlng) {
    var rec = measureShapes[measureCurrentIdx];
    var index = rec.points.length;
    rec.points.push(latlng);
    addVertexMarker(rec, latlng, index);
    redrawMeasureShape(rec);
  }

  function updateMeasureLabel(rec) {
    var pts = rec.points;
    var text;
    if (rec.mode === "area") {
      text = pts.length < 3 ? "clique para adicionar vértices" : fmtAreaMeasure(polygonAreaM2(pts));
      rec.label.setLatLng(pts.length >= 3 ? centroidLatLng(pts) : pts[pts.length - 1]);
    } else {
      var total = 0;
      for (var i = 1; i < pts.length; i++) { total += map.distance(pts[i - 1], pts[i]); }
      text = pts.length < 2 ? "clique para adicionar vértices" : fmtDistanceMeasure(total);
      rec.label.setLatLng(pts[pts.length - 1]);
    }
    rec.label.setContent(text);
  }

  map.on("click", function (e) {
    if (!measureMode) { return; }
    if (e.originalEvent && e.originalEvent.detail > 1) { return; } // ignora o clique que faz parte de um duplo-clique
    if (measureCurrentIdx === -1) { startMeasureShape(measureMode, e.latlng); } else { addMeasurePoint(e.latlng); }
  });
  map.on("dblclick", function () {
    if (!measureMode || measureCurrentIdx === -1) { return; }
    measureCurrentIdx = -1; // deixa a forma desenhada (e os vertices arrastaveis); o proximo clique comeca uma nova
  });

  if (btnMeasureLine) { btnMeasureLine.addEventListener("click", function () { setMeasureMode("line"); }); }
  if (btnMeasureArea) { btnMeasureArea.addEventListener("click", function () { setMeasureMode("area"); }); }
  if (btnMeasureClear) {
    btnMeasureClear.addEventListener("click", function () {
      measureLayer.clearLayers();
      measureShapes = [];
      measureCurrentIdx = -1;
    });
  }

  // ------------------------------------------------------------------
  // Controles gerais da UI
  // ------------------------------------------------------------------
  document.getElementById("sidebarToggle").addEventListener("click", function () {
    document.getElementById("app").classList.toggle("sidebar-collapsed");
    setTimeout(function () { map.invalidateSize(); }, 250);
  });
  document.getElementById("btnHome").addEventListener("click", function () {
    if (allBounds) { map.fitBounds(allBounds); }
  });
  document.getElementById("btnFullscreen").addEventListener("click", function () {
    var el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  });
  var coordBox = document.getElementById("coordReadout");
  map.on("mousemove", function (e) {
    coordBox.textContent = e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6);
  });
  map.on("mouseout", function () { coordBox.textContent = "lat, lon"; });

})();
