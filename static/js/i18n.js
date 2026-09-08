// Dicionario PT/EN pra interface fixa do mapa (index.html + app.js). Nao
// traduz dados do usuario (nomes de projeto, classes de vegetacao, blocos)
// -- so' o texto proprio da aplicacao.
(function () {
  "use strict";

  var DICT = {
    sidebar_toggle: { pt: "Mostrar/ocultar painel", en: "Show/hide panel" },
    dashboard_link: { pt: "Dashboard", en: "Dashboard" },
    voltar_mapa: { pt: "Voltar ao mapa", en: "Back to map" },
    home_title: { pt: "Zoom para a área", en: "Zoom to area" },
    fullscreen_title: { pt: "Tela cheia", en: "Fullscreen" },

    mapa_base_h: { pt: "Mapa Base", en: "Base Map" },
    satelite: { pt: "Satélite (Esri)", en: "Satellite (Esri)" },
    osm: { pt: "OpenStreetMap", en: "OpenStreetMap" },
    nenhum_fundo: { pt: "Nenhum (fundo escuro)", en: "None (dark background)" },

    medicao_h: { pt: "Medição", en: "Measurement" },
    medir_linha_title: { pt: "Medir distância", en: "Measure distance" },
    linha_btn: { pt: "📏 Linha", en: "📏 Line" },
    medir_area_title: { pt: "Medir área", en: "Measure area" },
    area_btn: { pt: "▱ Área", en: "▱ Area" },
    limpar_title: { pt: "Limpar medições", en: "Clear measurements" },
    limpar_btn: { pt: "Limpar", en: "Clear" },
    medicao_footer: {
      pt: "Clique no mapa para adicionar pontos, duplo-clique para terminar. Apenas visual, nada é salvo.",
      en: "Click the map to add points, double-click to finish. Visual only, nothing is saved."
    },
    medicao_prompt: { pt: "clique para adicionar vértices", en: "click to add vertices" },

    projeto_h: { pt: "Projeto", en: "Project" },
    carregando_catalogo: { pt: "Carregando catálogo...", en: "Loading catalog..." },
    nenhum_projeto: { pt: "Nenhum projeto no catálogo.", en: "No projects in the catalog." },
    falha_catalogo: { pt: "Falha ao carregar catálogo: ", en: "Failed to load catalog: " },
    projetos_carregados: { pt: " projeto(s) carregado(s).", en: " project(s) loaded." },
    selecionar_todos: { pt: "Selecionar todos", en: "Select all" },
    selecionado_s: { pt: " selecionado(s)", en: " selected" },
    ortofoto_label: { pt: "Ortofoto", en: "Orthophoto" },
    vegetacao_label: { pt: "Vegetação", en: "Vegetation" },
    foto_btn: { pt: "Foto", en: "Photo" },
    veg_btn: { pt: "Veg", en: "Veg" },

    legenda_veg_h: { pt: "Legenda de Vegetação", en: "Vegetation Legend" },
    restaurar_cores: { pt: "restaurar cores", en: "reset colors" },
    marcar_desmarcar_tudo: { pt: "Marcar/desmarcar tudo", en: "Select/deselect all" },
    mostrar_no_mapa: { pt: "Mostrar no mapa", en: "Show on map" },
    incluir_grafico: { pt: "Incluir no gráfico de cobertura", en: "Include in coverage chart" },
    cor_title: { pt: "Cor", en: "Color" },
    opacidade: { pt: "opacidade", en: "opacity" },

    cobertura_h: { pt: "Cobertura (%)", en: "Coverage (%)" },
    grafico_rosca: { pt: "Gráfico de rosca", en: "Donut chart" },
    grafico_pizza: { pt: "Gráfico de pizza", en: "Pie chart" },
    grafico_barras: { pt: "Gráfico de barras", en: "Bar chart" },
    sem_dados_visiveis: { pt: "sem dados visíveis", en: "no visible data" },

    comparar_camadas_h: { pt: "Comparar Camadas (Swipe)", en: "Compare Layers (Swipe)" },
    camada_a: { pt: "Camada A", en: "Layer A" },
    camada_b: { pt: "Camada B", en: "Layer B" },
    ortofoto_fundo: { pt: "Ortofoto de fundo", en: "Background orthophoto" },
    nenhuma: { pt: "Nenhuma", en: "None" },
    ativar_comparacao: { pt: "Ativar comparação", en: "Activate comparison" },
    desativar_comparacao: { pt: "Desativar comparação", en: "Deactivate comparison" },
    sufixo_ortofoto: { pt: " (Ortofoto)", en: " (Orthophoto)" },
    sufixo_vegetacao: { pt: " (Vegetação)", en: " (Vegetation)" },
    indice_crescimento: { pt: "Índice de crescimento — ", en: "Growth index — " },
    legenda_lado: { pt: "Vegetação ", en: "Vegetation " },

    crs_origem: { pt: "CRS de origem:", en: "Source CRS:" },
    publicado_em: { pt: "Publicado em:", en: "Published as:" },
    dados_atualizados: { pt: "Dados atualizados em:", en: "Data updated on:" }
  };

  var LANG_KEY = "geoportal_lang";
  var lang = localStorage.getItem(LANG_KEY) || "pt";

  function t(key) {
    var entry = DICT[key];
    if (!entry) { return key; }
    return entry[lang] || entry.pt;
  }

  function apply() {
    document.documentElement.lang = lang === "en" ? "en" : "pt-BR";
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    var toggleBtn = document.getElementById("langToggle");
    if (toggleBtn) { toggleBtn.textContent = lang === "en" ? "PT" : "EN"; }
    document.dispatchEvent(new CustomEvent("i18n:changed"));
  }

  function setLang(newLang) {
    lang = newLang === "en" ? "en" : "pt";
    localStorage.setItem(LANG_KEY, lang);
    apply();
  }

  window.I18N = { t: t, apply: apply, setLang: setLang, getLang: function () { return lang; } };

  document.addEventListener("DOMContentLoaded", function () {
    apply();
    var toggleBtn = document.getElementById("langToggle");
    if (toggleBtn) {
      // recarrega a pagina em vez de re-traduzir ao vivo -- boa parte do
      // conteudo (legenda, swipe, grafico) e' gerado dinamicamente com
      // estado proprio (cores, visibilidade escolhidas), reconstruir tudo
      // sem perder esse estado seria bem mais complexo do que recarregar
      // com o idioma ja salvo, que sai tudo certo desde o primeiro render.
      toggleBtn.addEventListener("click", function () {
        localStorage.setItem(LANG_KEY, lang === "en" ? "pt" : "en");
        window.location.reload();
      });
    }
  });
})();
