(function () {
  "use strict";

  var STORAGE_KEY = "mentes-do-una-sorteio-state-v2";
  var LEGACY_STORAGE_KEY = "sorteio-numeros-local-state-v1";
  var CHANNEL_NAME = "mentes-do-una-sorteio-channel";
  var ANIMATION_MS = 5200;
  var MAX_LOGO_SIZE = 2.5 * 1024 * 1024;
  var DEFAULT_LOGO_URL = "/assets/logo-mentes-do-una.png";
  var PLACEHOLDER_LOGO = "__placeholder__";
  var DEFAULT_EVENT_ID = "mentes-do-una";
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBT2npa2vaBPcZxYMRwj7qy-f-eHlBsNWQ",
    authDomain: "mentes-do-una-sorteio.firebaseapp.com",
    databaseURL: "https://mentes-do-una-sorteio-default-rtdb.firebaseio.com",
    projectId: "mentes-do-una-sorteio",
    storageBucket: "mentes-do-una-sorteio.firebasestorage.app",
    messagingSenderId: "122823406657",
    appId: "1:122823406657:web:9f0eec4bcf95784e2a02c0"
  };
  var DEFAULT_STATE = {
    version: 2,
    eventName: "Mentes do Una Podcast",
    rangeStart: 1,
    rangeEnd: 1000,
    drawnNumbers: [],
    history: [],
    lastDraw: null,
    logoDataUrl: "",
    roundStartedAt: new Date().toISOString(),
    updatedAt: Date.now()
  };

  var screen = document.body.dataset.screen;
  var numberFormatter = new Intl.NumberFormat("pt-BR");
  var dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium"
  });
  var timeFormatter = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  var channel = null;
  var lastSeenUpdate = 0;
  var toastTimer = null;
  var spinFrame = null;
  var spinTimer = null;
  var revealFlashTimer = null;
  var spinningDrawId = null;
  var revealedDrawId = null;
  var lastSpinTick = 0;
  var firebaseStateRef = null;
  var applyingRemoteState = false;
  var eventId = getEventId();

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (error) {
    channel = null;
  }

  function sanitizeInteger(value, fallback) {
    var parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }

  function uniqueNumbers(values) {
    var seen = new Set();
    var result = [];

    if (!Array.isArray(values)) {
      return result;
    }

    values.forEach(function (value) {
      var number = sanitizeInteger(value, null);
      if (number !== null && !seen.has(number)) {
        seen.add(number);
        result.push(number);
      }
    });

    return result;
  }

  function normalizeDraw(draw, index) {
    if (!draw || typeof draw !== "object") {
      return null;
    }

    var number = sanitizeInteger(draw.number, null);
    if (number === null) {
      return null;
    }

    return {
      id: typeof draw.id === "string" ? draw.id : "draw-" + Date.now() + "-" + index,
      number: number,
      sequence: sanitizeInteger(draw.sequence, index + 1),
      drawnAt: typeof draw.drawnAt === "string" ? draw.drawnAt : new Date().toISOString(),
      revealAt: typeof draw.revealAt === "string" ? draw.revealAt : draw.drawnAt || new Date().toISOString()
    };
  }

  function normalizeState(raw) {
    var source = raw && typeof raw === "object" ? raw : {};
    var rangeStart = sanitizeInteger(source.rangeStart, DEFAULT_STATE.rangeStart);
    var rangeEnd = sanitizeInteger(source.rangeEnd, DEFAULT_STATE.rangeEnd);
    var history = Array.isArray(source.history)
      ? source.history.map(normalizeDraw).filter(Boolean)
      : [];
    var lastDraw = normalizeDraw(source.lastDraw, 0) || history[0] || null;

    if (rangeEnd < rangeStart) {
      rangeEnd = rangeStart;
    }

    return {
      version: 2,
      eventName: typeof source.eventName === "string" && source.eventName.trim()
        ? source.eventName.trim().slice(0, 100)
        : DEFAULT_STATE.eventName,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      drawnNumbers: uniqueNumbers(source.drawnNumbers),
      history: history,
      lastDraw: lastDraw,
      logoDataUrl: typeof source.logoDataUrl === "string" ? source.logoDataUrl : "",
      roundStartedAt: typeof source.roundStartedAt === "string" ? source.roundStartedAt : DEFAULT_STATE.roundStartedAt,
      updatedAt: sanitizeInteger(source.updatedAt, Date.now())
    };
  }

  function getEventId() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get("evento") || params.get("event") || DEFAULT_EVENT_ID;
    var normalized = raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

    return normalized || DEFAULT_EVENT_ID;
  }

  function readState() {
    try {
      var current = localStorage.getItem(STORAGE_KEY);
      if (current) {
        return normalizeState(JSON.parse(current));
      }

      var legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        return normalizeState(JSON.parse(legacy));
      }
    } catch (error) {
      return normalizeState(null);
    }

    return normalizeState(null);
  }

  function pushRemoteState(state) {
    if (!firebaseStateRef || applyingRemoteState) {
      return;
    }

    firebaseStateRef.set(state).catch(function (error) {
      showToast("Nao foi possivel sincronizar com o Firebase: " + error.message);
    });
  }

  function writeState(nextState, options) {
    var normalized = normalizeState(nextState);
    normalized.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    lastSeenUpdate = normalized.updatedAt;

    if (channel) {
      channel.postMessage({ type: "state-updated", updatedAt: normalized.updatedAt });
    }

    if (!options || !options.skipRemote) {
      pushRemoteState(normalized);
    }

    return normalized;
  }

  function ensureInitialState() {
    if (!localStorage.getItem(STORAGE_KEY)) {
      writeState(readState());
    }
  }

  function sync(handler) {
    function renderFromStorage() {
      var state = readState();
      if (state.updatedAt !== lastSeenUpdate) {
        lastSeenUpdate = state.updatedAt;
        handler(state);
      }
    }

    window.addEventListener("storage", function (event) {
      if (event.key === STORAGE_KEY || event.key === LEGACY_STORAGE_KEY) {
        renderFromStorage();
      }
    });

    if (channel) {
      channel.addEventListener("message", function (event) {
        if (event.data && event.data.type === "state-updated") {
          renderFromStorage();
        }
      });
    }

    window.setInterval(renderFromStorage, 900);
  }

  function applyRemoteState(remoteState, handler) {
    var normalized = normalizeState(remoteState);

    if (normalized.updatedAt === readState().updatedAt) {
      return;
    }

    applyingRemoteState = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    applyingRemoteState = false;
    lastSeenUpdate = normalized.updatedAt;

    if (channel) {
      channel.postMessage({ type: "state-updated", updatedAt: normalized.updatedAt });
    }

    handler(normalized);
  }

  function hydrateEventLinks() {
    document.querySelectorAll('a[href^="/painel/"], a[href^="/apresentacao/"]').forEach(function (link) {
      var url = new URL(link.getAttribute("href"), window.location.origin);
      url.searchParams.set("evento", eventId);
      link.href = url.pathname + url.search;
    });
  }

  function initFirebaseSync(handler) {
    if (!window.firebase || !window.firebase.database) {
      setText("#panelSyncStatus", "Local");
      setText("#presentationSync", "Firebase indisponivel. Usando sincronizacao local.");
      return;
    }

    try {
      if (!window.firebase.apps.length) {
        window.firebase.initializeApp(FIREBASE_CONFIG);
      }

      firebaseStateRef = window.firebase.database().ref("eventos/" + eventId + "/state");
      window.firebase.database().ref(".info/connected").on("value", function (snapshot) {
        var connected = snapshot.val() === true;
        setText("#panelSyncStatus", connected ? "Online Firebase" : "Reconectando...");
        setText("#presentationSync", connected ? "Atualizacao online ativa - evento " + eventId : "Reconectando ao Firebase...");
      });

      firebaseStateRef.on("value", function (snapshot) {
        var remoteState = snapshot.val();

        if (remoteState) {
          applyRemoteState(remoteState, handler);
          return;
        }

        if (screen === "panel") {
          pushRemoteState(readState());
        }
      }, function (error) {
        showToast("Erro no Firebase: " + error.message);
        setText("#panelSyncStatus", "Erro Firebase");
        setText("#presentationSync", "Firebase sem permissao ou indisponivel");
      });

      setText("#panelSyncStatus", "Online Firebase");
      setText("#presentationSync", "Atualizacao online ativa - evento " + eventId);
    } catch (error) {
      showToast("Erro ao iniciar Firebase: " + error.message);
      setText("#panelSyncStatus", "Local");
      setText("#presentationSync", "Firebase indisponivel. Usando sincronizacao local.");
    }
  }

  function rangeTotal(state) {
    return Math.max(0, state.rangeEnd - state.rangeStart + 1);
  }

  function inRange(state, number) {
    return number >= state.rangeStart && number <= state.rangeEnd;
  }

  function currentDrawnSet(state) {
    return new Set(state.drawnNumbers.filter(function (number) {
      return inRange(state, number);
    }));
  }

  function remainingCount(state) {
    return Math.max(0, rangeTotal(state) - currentDrawnSet(state).size);
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === "--") {
      return "--";
    }

    return numberFormatter.format(value);
  }

  function formatDateTime(value) {
    if (!value) {
      return "";
    }

    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return dateTimeFormatter.format(date);
  }

  function randomInt(maxExclusive) {
    if (maxExclusive <= 0) {
      return 0;
    }

    if (window.crypto && window.crypto.getRandomValues && maxExclusive <= 0x100000000) {
      var range = 0x100000000;
      var limit = range - (range % maxExclusive);
      var buffer = new Uint32Array(1);
      var value = 0;

      do {
        window.crypto.getRandomValues(buffer);
        value = buffer[0];
      } while (value >= limit);

      return value % maxExclusive;
    }

    return Math.floor(Math.random() * maxExclusive);
  }

  function pickRemainingNumber(state) {
    var used = currentDrawnSet(state);
    var remaining = rangeTotal(state) - used.size;
    var target = randomInt(remaining);
    var cursor = 0;
    var number;

    if (remaining <= 0) {
      return null;
    }

    for (number = state.rangeStart; number <= state.rangeEnd; number += 1) {
      if (!used.has(number)) {
        if (cursor === target) {
          return number;
        }
        cursor += 1;
      }
    }

    return null;
  }

  function createDraw(number, sequence) {
    var now = new Date();

    return {
      id: "draw-" + now.getTime() + "-" + randomInt(1000000),
      number: number,
      sequence: sequence,
      drawnAt: now.toISOString(),
      revealAt: new Date(now.getTime() + ANIMATION_MS).toISOString()
    };
  }

  function pluralize(count, singular, plural) {
    return formatNumber(count) + " " + (count === 1 ? singular : plural);
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    if (!toast) {
      return;
    }

    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 3400);
  }

  function setText(selector, value, root) {
    var element = (root || document).querySelector(selector);
    if (element) {
      element.textContent = value;
    }
  }

  function updateTimeElement(element, isoValue, label) {
    if (!element) {
      return;
    }

    element.dateTime = isoValue || "";
    element.textContent = label;
  }

  function renderLogoSlot(element, logoDataUrl, eventName) {
    if (!element) {
      return;
    }

    element.replaceChildren();

    if (logoDataUrl && logoDataUrl !== PLACEHOLDER_LOGO) {
      var image = document.createElement("img");
      image.src = logoDataUrl;
      image.alt = "Logo " + eventName;
      element.appendChild(image);
      return;
    }

    if (!logoDataUrl && DEFAULT_LOGO_URL) {
      var defaultImage = document.createElement("img");
      defaultImage.src = DEFAULT_LOGO_URL;
      defaultImage.alt = "Logo " + eventName;
      element.appendChild(defaultImage);
      return;
    }

    var placeholder = document.createElement("span");
    placeholder.textContent = "LOGO";
    element.appendChild(placeholder);
  }

  function renderAllLogos(state) {
    document.querySelectorAll("[data-logo-slot]").forEach(function (element) {
      renderLogoSlot(element, state.logoDataUrl, state.eventName);
    });
  }

  function renderHistory(listElement, history, options) {
    var limit = options && options.limit ? options.limit : history.length;
    var visibleHistory = history.slice(0, limit);

    if (!listElement) {
      return;
    }

    listElement.replaceChildren();

    if (!visibleHistory.length) {
      var empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "Nenhum numero sorteado ainda.";
      listElement.appendChild(empty);
      return;
    }

    visibleHistory.forEach(function (draw) {
      var item = document.createElement("li");
      var sequence = document.createElement("span");
      var number = document.createElement("strong");
      var time = document.createElement("time");

      item.className = "history-item";
      sequence.className = "history-sequence";
      sequence.textContent = "#" + draw.sequence;
      number.className = "history-number";
      number.textContent = formatNumber(draw.number);
      time.className = "history-time";
      time.dateTime = draw.drawnAt;
      time.textContent = formatDateTime(draw.drawnAt);

      item.append(sequence, number, time);
      listElement.appendChild(item);
    });
  }

  function isAcceptedLogo(file) {
    var extension = file.name.split(".").pop().toLowerCase();
    var acceptedTypes = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
    return acceptedTypes.indexOf(file.type) >= 0 || ["png", "jpg", "jpeg", "svg"].indexOf(extension) >= 0;
  }

  function exportExcelFallback(state) {
    var xmlEscape = function (value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    };
    var rows = state.history.slice().reverse().map(function (draw) {
      return "<Row>" +
        "<Cell><Data ss:Type=\"Number\">" + draw.sequence + "</Data></Cell>" +
        "<Cell><Data ss:Type=\"Number\">" + draw.number + "</Data></Cell>" +
        "<Cell><Data ss:Type=\"String\">" + xmlEscape(formatDateTime(draw.drawnAt)) + "</Data></Cell>" +
        "<Cell><Data ss:Type=\"String\">" + xmlEscape(draw.drawnAt) + "</Data></Cell>" +
        "<Cell><Data ss:Type=\"String\">" + xmlEscape(state.eventName) + "</Data></Cell>" +
      "</Row>";
    }).join("");
    var workbook = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
      "<?mso-application progid=\"Excel.Sheet\"?>" +
      "<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">" +
      "<Worksheet ss:Name=\"Historico\"><Table>" +
      "<Row><Cell><Data ss:Type=\"String\">Ordem</Data></Cell><Cell><Data ss:Type=\"String\">Numero</Data></Cell><Cell><Data ss:Type=\"String\">Data</Data></Cell><Cell><Data ss:Type=\"String\">Timestamp</Data></Cell><Cell><Data ss:Type=\"String\">Evento</Data></Cell></Row>" +
      rows +
      "</Table></Worksheet></Workbook>";
    var blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
    var link = document.createElement("a");

    link.href = URL.createObjectURL(blob);
    link.download = "historico-sorteio-" + new Date().toISOString().slice(0, 10) + ".xls";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(link.href);
    }, 1000);
  }

  function exportExcel(state) {
    var rows;
    var workbook;
    var worksheet;

    if (!state.history.length) {
      showToast("Nao ha historico para exportar.");
      return;
    }

    if (!window.XLSX) {
      exportExcelFallback(state);
      showToast("Historico exportado em Excel.");
      return;
    }

    rows = state.history.slice().reverse().map(function (draw) {
      return {
        Ordem: draw.sequence,
        Numero: draw.number,
        Data: formatDateTime(draw.drawnAt),
        Timestamp: draw.drawnAt,
        Evento: state.eventName,
        Faixa: state.rangeStart + " a " + state.rangeEnd
      };
    });

    workbook = window.XLSX.utils.book_new();
    worksheet = window.XLSX.utils.json_to_sheet(rows);
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Historico");
    window.XLSX.writeFile(workbook, "historico-sorteio-" + new Date().toISOString().slice(0, 10) + ".xlsx");
    showToast("Historico exportado em Excel.");
  }

  function initHome() {
    ensureInitialState();
    hydrateEventLinks();

    function render(state) {
      document.querySelectorAll("[data-event-name]").forEach(function (element) {
        element.textContent = state.eventName;
      });
      renderAllLogos(state);
    }

    lastSeenUpdate = readState().updatedAt;
    render(readState());
    initFirebaseSync(render);
    sync(render);
  }

  function initPanel() {
    ensureInitialState();
    hydrateEventLinks();

    var elements = {
      drawButton: document.getElementById("drawButton"),
      settingsButton: document.getElementById("settingsButton"),
      restartButton: document.getElementById("restartButton"),
      clearHistoryButton: document.getElementById("clearHistoryButton"),
      exportButton: document.getElementById("exportButton"),
      settingsDialog: document.getElementById("settingsDialog"),
      settingsForm: document.getElementById("settingsForm"),
      closeSettingsButton: document.getElementById("closeSettingsButton"),
      cancelSettingsButton: document.getElementById("cancelSettingsButton"),
      eventNameInput: document.getElementById("eventNameInput"),
      rangeStartInput: document.getElementById("rangeStartInput"),
      rangeEndInput: document.getElementById("rangeEndInput"),
      logoInput: document.getElementById("logoInput"),
      logoPreview: document.getElementById("logoPreview"),
      removeLogoButton: document.getElementById("removeLogoButton"),
      settingsError: document.getElementById("settingsError"),
      lastNumber: document.getElementById("lastNumber"),
      lastDrawTime: document.getElementById("lastDrawTime"),
      remainingCount: document.getElementById("remainingCount"),
      drawnCount: document.getElementById("drawnCount"),
      rangeSummary: document.getElementById("rangeSummary"),
      historyCount: document.getElementById("historyCount"),
      historyList: document.getElementById("historyList")
    };
    var logoDraft = "";

    function render(state) {
      var last = state.lastDraw;
      var remaining = remainingCount(state);
      var drawn = currentDrawnSet(state).size;

      document.querySelectorAll("[data-event-name]").forEach(function (element) {
        element.textContent = state.eventName;
      });

      renderAllLogos(state);
      elements.lastNumber.textContent = last ? formatNumber(last.number) : "--";
      updateTimeElement(
        elements.lastDrawTime,
        last ? last.drawnAt : "",
        last ? "Sorteado em " + formatDateTime(last.drawnAt) : "Aguardando primeiro sorteio"
      );
      elements.remainingCount.textContent = formatNumber(remaining);
      elements.drawnCount.textContent = formatNumber(drawn);
      elements.rangeSummary.textContent = formatNumber(state.rangeStart) + "-" + formatNumber(state.rangeEnd);
      elements.historyCount.textContent = pluralize(state.history.length, "item", "itens");
      elements.drawButton.disabled = remaining <= 0;
      elements.exportButton.disabled = state.history.length <= 0;
      renderHistory(elements.historyList, state.history);
    }

    function openSettings() {
      var state = readState();

      elements.eventNameInput.value = state.eventName;
      elements.rangeStartInput.value = state.rangeStart;
      elements.rangeEndInput.value = state.rangeEnd;
      logoDraft = state.logoDataUrl;
      elements.settingsError.textContent = "";
      renderLogoSlot(elements.logoPreview, logoDraft, state.eventName);

      if (typeof elements.settingsDialog.showModal === "function") {
        elements.settingsDialog.showModal();
      } else {
        elements.settingsDialog.setAttribute("open", "open");
      }
    }

    function closeSettings() {
      elements.settingsDialog.close();
    }

    elements.drawButton.addEventListener("click", function () {
      var state = readState();
      var number = pickRemainingNumber(state);
      var draw;
      var nextState;

      if (number === null) {
        showToast("Todos os numeros da faixa ja foram sorteados.");
        return;
      }

      draw = createDraw(number, state.history.length + 1);
      nextState = writeState({
        version: 2,
        eventName: state.eventName,
        rangeStart: state.rangeStart,
        rangeEnd: state.rangeEnd,
        drawnNumbers: uniqueNumbers(state.drawnNumbers.concat([number])),
        history: [draw].concat(state.history),
        lastDraw: draw,
        logoDataUrl: state.logoDataUrl,
        roundStartedAt: state.roundStartedAt,
        updatedAt: Date.now()
      });

      render(nextState);
      showToast("Numero " + formatNumber(number) + " sorteado.");
    });

    elements.settingsButton.addEventListener("click", openSettings);
    elements.closeSettingsButton.addEventListener("click", closeSettings);
    elements.cancelSettingsButton.addEventListener("click", closeSettings);

    elements.logoInput.addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      var reader;

      if (!file) {
        return;
      }

      if (!isAcceptedLogo(file)) {
        elements.settingsError.textContent = "Use uma imagem PNG, JPG, JPEG ou SVG.";
        return;
      }

      if (file.size > MAX_LOGO_SIZE) {
        elements.settingsError.textContent = "A logo deve ter ate 2,5 MB para caber no armazenamento local.";
        return;
      }

      reader = new FileReader();
      reader.onload = function () {
        logoDraft = typeof reader.result === "string" ? reader.result : "";
        elements.settingsError.textContent = "";
        renderLogoSlot(elements.logoPreview, logoDraft, elements.eventNameInput.value || DEFAULT_STATE.eventName);
      };
      reader.readAsDataURL(file);
    });

    elements.removeLogoButton.addEventListener("click", function () {
      logoDraft = PLACEHOLDER_LOGO;
      elements.logoInput.value = "";
      renderLogoSlot(elements.logoPreview, logoDraft, elements.eventNameInput.value || DEFAULT_STATE.eventName);
    });

    elements.settingsForm.addEventListener("submit", function (event) {
      var state = readState();
      var eventName = elements.eventNameInput.value.trim() || DEFAULT_STATE.eventName;
      var rangeStart = Number(elements.rangeStartInput.value);
      var rangeEnd = Number(elements.rangeEndInput.value);
      var nextState;

      event.preventDefault();

      if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)) {
        elements.settingsError.textContent = "Informe numeros inteiros validos.";
        return;
      }

      if (rangeEnd < rangeStart) {
        elements.settingsError.textContent = "O numero final deve ser maior ou igual ao inicial.";
        return;
      }

      nextState = writeState({
        version: 2,
        eventName: eventName,
        rangeStart: rangeStart,
        rangeEnd: rangeEnd,
        drawnNumbers: state.drawnNumbers,
        history: state.history,
        lastDraw: state.lastDraw,
        logoDataUrl: logoDraft,
        roundStartedAt: state.roundStartedAt,
        updatedAt: Date.now()
      });

      render(nextState);
      closeSettings();
      showToast("Configuracoes salvas.");
    });

    elements.restartButton.addEventListener("click", function () {
      var state;
      var nextState;

      if (!window.confirm("Reiniciar o sorteio? O historico sera apagado e todos os numeros voltarao a ficar disponiveis.")) {
        return;
      }

      state = readState();
      nextState = writeState({
        version: 2,
        eventName: state.eventName,
        rangeStart: state.rangeStart,
        rangeEnd: state.rangeEnd,
        drawnNumbers: [],
        history: [],
        lastDraw: null,
        logoDataUrl: state.logoDataUrl,
        roundStartedAt: new Date().toISOString(),
        updatedAt: Date.now()
      });

      render(nextState);
      showToast("Sorteio reiniciado.");
    });

    elements.clearHistoryButton.addEventListener("click", function () {
      var state;
      var nextState;

      if (!window.confirm("Limpar o historico exibido e exportavel? Os numeros ja sorteados continuarao bloqueados ate reiniciar o sorteio.")) {
        return;
      }

      state = readState();
      nextState = writeState({
        version: 2,
        eventName: state.eventName,
        rangeStart: state.rangeStart,
        rangeEnd: state.rangeEnd,
        drawnNumbers: state.drawnNumbers,
        history: [],
        lastDraw: state.lastDraw,
        logoDataUrl: state.logoDataUrl,
        roundStartedAt: state.roundStartedAt,
        updatedAt: Date.now()
      });

      render(nextState);
      showToast("Historico limpo.");
    });

    elements.exportButton.addEventListener("click", function () {
      exportExcel(readState());
    });

    lastSeenUpdate = readState().updatedAt;
    render(readState());
    initFirebaseSync(render);
    sync(render);
  }

  function randomInRange(state) {
    var total = rangeTotal(state);
    if (total <= 0) {
      return state.rangeStart;
    }
    return state.rangeStart + randomInt(total);
  }

  function setSpinProgress(active) {
    var number = document.getElementById("presentationNumber");
    var stage = number ? number.closest(".draw-stage") : null;
    if (stage) {
      stage.classList.toggle("is-spinning", active);
    }
  }

  function setRevealFlash(active) {
    var number = document.getElementById("presentationNumber");
    var stage = number ? number.closest(".draw-stage") : null;
    if (stage) {
      stage.classList.toggle("is-revealed", active);
    }
  }

  function stopSpin() {
    var number = document.getElementById("presentationNumber");
    var label = document.getElementById("presentationStageLabel");
    var time = document.getElementById("presentationDrawTime");

    if (spinFrame) {
      window.cancelAnimationFrame(spinFrame);
      spinFrame = null;
    }

    if (spinTimer) {
      window.clearTimeout(spinTimer);
      spinTimer = null;
    }

    if (revealFlashTimer) {
      window.clearTimeout(revealFlashTimer);
      revealFlashTimer = null;
    }

    spinningDrawId = null;
    lastSpinTick = 0;
    setSpinProgress(false);

    if (number) {
      number.classList.remove("is-spinning");
    }

    if (label) {
      label.classList.remove("is-spinning");
    }

    if (time) {
      time.classList.remove("is-spinning");
    }
  }

  function revealPresentationDraw(draw) {
    var number = document.getElementById("presentationNumber");
    var label = document.getElementById("presentationStageLabel");
    var time = document.getElementById("presentationDrawTime");

    stopSpin();
    revealedDrawId = draw ? draw.id : null;

    if (!draw) {
      if (number) {
        number.textContent = "--";
      }
      if (label) {
        label.textContent = "Aguardando sorteio";
      }
      updateTimeElement(time, "", "Sem sorteio registrado");
      return;
    }

    if (number) {
      number.textContent = formatNumber(draw.number);
      number.classList.add("is-revealed");
      revealFlashTimer = window.setTimeout(function () {
        number.classList.remove("is-revealed");
        setRevealFlash(false);
      }, 1200);
    }

    if (label) {
      label.textContent = "Numero sorteado";
      label.classList.remove("is-spinning");
    }

    setRevealFlash(true);
    updateTimeElement(time, draw.drawnAt, "Sorteado em " + formatDateTime(draw.drawnAt));
    if (time) {
      time.classList.remove("is-spinning");
    }
  }

  function startPresentationSpin(draw, state) {
    var number = document.getElementById("presentationNumber");
    var label = document.getElementById("presentationStageLabel");
    var time = document.getElementById("presentationDrawTime");
    var revealAt = new Date(draw.revealAt).getTime();
    var remaining = Math.max(0, revealAt - Date.now());

    stopSpin();
    spinningDrawId = draw.id;
    revealedDrawId = null;
    setSpinProgress(true);

    if (number) {
      number.classList.add("is-spinning");
      number.classList.remove("is-revealed");
    }

    if (label) {
      label.textContent = "Sorteando... suspense no ar";
      label.classList.add("is-spinning");
    }

    updateTimeElement(time, draw.drawnAt, "Preparando resultado");
    if (time) {
      time.classList.add("is-spinning");
    }

    function tick(timestamp) {
      if (!spinningDrawId || spinningDrawId !== draw.id) {
        return;
      }

      if (!lastSpinTick || timestamp - lastSpinTick > 42) {
        lastSpinTick = timestamp;
        if (number) {
          number.textContent = formatNumber(randomInRange(state));
        }
      }

      spinFrame = window.requestAnimationFrame(tick);
    }

    spinFrame = window.requestAnimationFrame(tick);
    spinTimer = window.setTimeout(function () {
      revealPresentationDraw(draw);
      renderPresentation(readState());
    }, remaining);
  }

  function renderPresentation(state) {
    var last = state.lastDraw;
    var historyList = document.getElementById("presentationHistoryList");
    var historyCount = document.getElementById("presentationHistoryCount");
    var currentNumber = document.getElementById("presentationNumber");
    var label = document.getElementById("presentationStageLabel");
    var remaining = remainingCount(state);
    var revealAt;
    var shouldSpin;
    var historyForDisplay;

    setText("#presentationEventName", state.eventName);
    setText("#presentationRange", "Faixa " + formatNumber(state.rangeStart) + "-" + formatNumber(state.rangeEnd));
    setText("#presentationRemaining", pluralize(remaining, "numero restante", "numeros restantes"));
    renderAllLogos(state);

    if (!last) {
      stopSpin();
      if (currentNumber) {
        currentNumber.textContent = "--";
      }
      if (label) {
        label.textContent = "Aguardando sorteio";
      }
      updateTimeElement(document.getElementById("presentationDrawTime"), "", "Sem sorteio registrado");
      renderHistory(historyList, state.history, { limit: 18 });
      if (historyCount) {
        historyCount.textContent = formatNumber(state.history.length);
      }
      return;
    }

    revealAt = new Date(last.revealAt).getTime();
    shouldSpin = Date.now() < revealAt && revealedDrawId !== last.id;

    if (shouldSpin) {
      if (spinningDrawId !== last.id) {
        startPresentationSpin(last, state);
      }
    } else if (spinningDrawId !== last.id || revealedDrawId !== last.id) {
      revealPresentationDraw(last);
    }

    historyForDisplay = spinningDrawId === last.id
      ? state.history.filter(function (draw) {
        return draw.id !== last.id;
      })
      : state.history;

    renderHistory(historyList, historyForDisplay, { limit: 18 });

    if (historyCount) {
      historyCount.textContent = formatNumber(historyForDisplay.length);
    }
  }

  function initPresentation() {
    var fullscreenButton = document.getElementById("fullscreenButton");
    var clock = document.getElementById("presentationClock");

    function updateClock() {
      var now = new Date();
      if (clock) {
        clock.dateTime = now.toISOString();
        clock.textContent = timeFormatter.format(now);
      }
    }

    fullscreenButton.addEventListener("click", function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {
          setText("#presentationSync", "Tela cheia indisponivel neste navegador");
        });
      } else {
        document.exitFullscreen();
      }
    });

    ensureInitialState();
    hydrateEventLinks();
    updateClock();
    window.setInterval(updateClock, 1000);
    lastSeenUpdate = readState().updatedAt;
    renderPresentation(readState());
    initFirebaseSync(renderPresentation);
    sync(renderPresentation);
  }

  if (screen === "home") {
    initHome();
  }

  if (screen === "panel") {
    initPanel();
  }

  if (screen === "presentation") {
    initPresentation();
  }
}());
