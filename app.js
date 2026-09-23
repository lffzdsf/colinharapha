(() => {
  "use strict";

  const slots = [
    { id: "estadual", office: "estadual", label: "Deputado(a) Estadual", hint: "5 dígitos" },
    { id: "senador1", office: "senador", label: "Senador(a) — 1ª opção", hint: "3 dígitos" },
    { id: "senador2", office: "senador", label: "Senador(a) — 2ª opção", hint: "3 dígitos" },
    { id: "governador", office: "governador", label: "Governador(a)", hint: "2 dígitos" },
    { id: "presidente", office: "presidente", label: "Presidente", hint: "2 dígitos" },
  ];

  const canvasLabels = {
    federal: "Deputado Federal",
    estadual: "Deputado(a) Estadual",
    senador1: "Senador(a) — 1º voto",
    senador2: "Senador(a) — 2º voto",
    governador: "Governador(a)",
    presidente: "Presidente",
  };

  const state = Object.fromEntries(slots.map((slot) => [slot.id, null]));
  const imageCache = new Map();
  let candidateData = null;
  let candidatesByOffice = new Map();
  let candidatesById = new Map();
  let selectedFormat = "feed";
  let renderToken = 0;
  let toastTimer = null;

  const fieldContainer = document.querySelector("#candidate-fields");
  const progressText = document.querySelector("#progress-text");
  const progressBar = document.querySelector("#progress-bar");
  const resetButton = document.querySelector("#reset-button");
  const canvas = document.querySelector("#collage-canvas");
  const canvasShell = document.querySelector("#canvas-shell");
  const downloadButton = document.querySelector("#download-button");
  const shareButton = document.querySelector("#share-button");
  const toast = document.querySelector("#toast");

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function spriteSvg(candidate) {
    if (!candidate.photo || !Array.isArray(candidate.photoRect)) return "";
    const [x, y, width, height, atlasWidth, atlasHeight] = candidate.photoRect;
    return `<svg class="photo-sprite" viewBox="${x} ${y} ${width} ${height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><image href="${escapeHtml(candidate.photo)}" x="0" y="0" width="${atlasWidth}" height="${atlasHeight}"></image></svg>`;
  }

  function photoMarkup(candidate, className) {
    if (candidate.photo && Array.isArray(candidate.photoRect)) {
      return `<span class="${className}">${spriteSvg(candidate)}</span>`;
    }
    if (candidate.photo) {
      return `<span class="${className}"><img src="${escapeHtml(candidate.photo)}" alt="" loading="lazy"></span>`;
    }
    return `<span class="${className}"><span class="photo-fallback" aria-label="Foto ainda não disponibilizada pelo TSE">${escapeHtml(initials(candidate.name))}</span></span>`;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function updateProgress() {
    const chosen = 1 + Object.values(state).filter(Boolean).length;
    progressText.textContent = `${chosen} de 6 escolhas definidas`;
    progressBar.style.width = `${(chosen / 6) * 100}%`;
    resetButton.disabled = chosen === 1;
  }

  function candidateFieldMarkup(slot, index) {
    const candidate = state[slot.id];
    if (candidate) {
      return `
        <article class="candidate-field" data-slot="${slot.id}">
          <div class="field-head">
            <span class="step-number">${index + 2}</span>
            <span class="field-title">${slot.label}</span>
            <span class="field-hint">${slot.hint}</span>
          </div>
          <div class="selected-choice">
            ${photoMarkup(candidate, "choice-photo")}
            <span class="choice-copy">
              <strong>${escapeHtml(candidate.name)}</strong>
              <span>${escapeHtml(candidate.party)}</span>
            </span>
            <span class="choice-number">${escapeHtml(candidate.number)}</span>
            <button class="change-button" type="button" data-change="${slot.id}">Trocar</button>
          </div>
        </article>`;
    }

    return `
      <article class="candidate-field" data-slot="${slot.id}">
        <div class="field-head">
          <span class="step-number">${index + 2}</span>
          <label class="field-title" for="search-${slot.id}">${slot.label}</label>
          <span class="field-hint">${slot.hint}</span>
        </div>
        <div class="search-wrap">
          <input
            id="search-${slot.id}"
            class="search-input"
            type="search"
            inputmode="search"
            autocomplete="off"
            placeholder="Digite o nome ou o número"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
            aria-controls="results-${slot.id}"
          />
          <svg class="search-icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <div id="results-${slot.id}" class="search-results" role="listbox" hidden></div>
        </div>
      </article>`;
  }

  function renderFields(focusSlot = null) {
    fieldContainer.innerHTML = slots.map(candidateFieldMarkup).join("");
    fieldContainer.setAttribute("aria-busy", "false");

    fieldContainer.querySelectorAll(".change-button").forEach((button) => {
      button.addEventListener("click", () => {
        const slotId = button.dataset.change;
        state[slotId] = null;
        renderFields(slotId);
        updateProgress();
        renderCanvas();
      });
    });

    slots.forEach((slot) => {
      const input = document.querySelector(`#search-${slot.id}`);
      if (!input) return;
      const results = document.querySelector(`#results-${slot.id}`);
      let activeIndex = -1;
      let currentResults = [];

      const closeResults = () => {
        results.hidden = true;
        input.setAttribute("aria-expanded", "false");
        activeIndex = -1;
      };

      const paintResults = () => {
        const query = normalize(input.value);
        if (!query) {
          closeResults();
          return;
        }

        const pool = candidatesByOffice.get(slot.office) || [];
        const numeric = /^\d+$/.test(query);
        currentResults = pool
          .filter((candidate) => {
            if (numeric) return candidate.number.startsWith(query);
            return candidate.search.includes(query);
          })
          .sort((a, b) => {
            const exactA = a.number === query || normalize(a.name) === query ? 0 : 1;
            const exactB = b.number === query || normalize(b.name) === query ? 0 : 1;
            if (exactA !== exactB) return exactA - exactB;
            const startsA = normalize(a.name).startsWith(query) ? 0 : 1;
            const startsB = normalize(b.name).startsWith(query) ? 0 : 1;
            if (startsA !== startsB) return startsA - startsB;
            return a.name.localeCompare(b.name, "pt-BR");
          })
          .slice(0, 7);

        if (!currentResults.length) {
          results.innerHTML = `<p class="no-results">Nenhum candidato encontrado para este cargo.</p>`;
        } else {
          results.innerHTML = currentResults
            .map(
              (candidate, resultIndex) => `
                <button
                  class="result-item${resultIndex === activeIndex ? " is-active" : ""}"
                  type="button"
                  role="option"
                  data-candidate="${candidate.id}"
                  aria-selected="${resultIndex === activeIndex}">
                  ${photoMarkup(candidate, "result-photo")}
                  <span class="result-copy">
                    <strong>${escapeHtml(candidate.name)}</strong>
                    <span>${escapeHtml(candidate.party)}</span>
                  </span>
                  <span class="result-number">${escapeHtml(candidate.number)}</span>
                </button>`,
            )
            .join("");

          results.querySelectorAll(".result-item").forEach((button) => {
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", () => selectCandidate(slot.id, button.dataset.candidate));
          });
        }
        results.hidden = false;
        input.setAttribute("aria-expanded", "true");
      };

      input.addEventListener("input", () => {
        activeIndex = -1;
        paintResults();
      });
      input.addEventListener("focus", paintResults);
      input.addEventListener("blur", () => window.setTimeout(closeResults, 130));
      input.addEventListener("keydown", (event) => {
        if (results.hidden || !currentResults.length) {
          if (event.key === "Escape") closeResults();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
          paintResults();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          activeIndex = Math.max(activeIndex - 1, 0);
          paintResults();
        } else if (event.key === "Enter" && activeIndex >= 0) {
          event.preventDefault();
          selectCandidate(slot.id, currentResults[activeIndex].id);
        } else if (event.key === "Escape") {
          closeResults();
        }
      });
    });

    if (focusSlot) {
      window.requestAnimationFrame(() => document.querySelector(`#search-${focusSlot}`)?.focus());
    }
  }

  function selectCandidate(slotId, candidateId) {
    const candidate = candidatesById.get(String(candidateId));
    if (!candidate) return;

    if (slotId === "senador1" || slotId === "senador2") {
      const otherSlot = slotId === "senador1" ? "senador2" : "senador1";
      if (state[otherSlot]?.id === candidate.id) {
        showToast("Escolha dois candidatos diferentes para o Senado.");
        return;
      }
    }

    state[slotId] = candidate;
    renderFields();
    updateProgress();
    renderCanvas();
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function loadImage(path) {
    if (!path) return Promise.resolve(null);
    if (!imageCache.has(path)) {
      imageCache.set(
        path,
        new Promise((resolve) => {
          const image = new Image();
          image.decoding = "async";
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = path;
        }),
      );
    }
    return imageCache.get(path);
  }

  function drawImageCover(context, image, x, y, width, height, radius, fallbackName, sourceRect = null) {
    context.save();
    roundedRectPath(context, x, y, width, height, radius);
    context.clip();
    if (image) {
      const baseX = sourceRect?.[0] || 0;
      const baseY = sourceRect?.[1] || 0;
      const baseWidth = sourceRect?.[2] || image.naturalWidth || image.width;
      const baseHeight = sourceRect?.[3] || image.naturalHeight || image.height;
      const scale = Math.max(width / baseWidth, height / baseHeight);
      const sourceWidth = width / scale;
      const sourceHeight = height / scale;
      const sourceX = baseX + (baseWidth - sourceWidth) / 2;
      const sourceY = baseY + Math.max(0, (baseHeight - sourceHeight) * 0.18);
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
    } else {
      const gradient = context.createLinearGradient(x, y, x + width, y + height);
      gradient.addColorStop(0, "#eef4f8");
      gradient.addColorStop(1, "#cad9e8");
      context.fillStyle = gradient;
      context.fillRect(x, y, width, height);
      context.fillStyle = "#536681";
      context.font = `800 ${Math.round(width * 0.27)}px Montserrat, Arial, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(initials(fallbackName || ""), x + width / 2, y + height / 2);
    }
    context.restore();
  }

  function fitText(context, text, maxWidth, startSize, minSize, weight = 800) {
    let size = startSize;
    while (size > minSize) {
      context.font = `${weight} ${size}px Montserrat, Arial, sans-serif`;
      if (context.measureText(text).width <= maxWidth) return size;
      size -= 1;
    }
    return minSize;
  }

  function ellipsize(context, text, maxWidth) {
    if (context.measureText(text).width <= maxWidth) return text;
    let output = text;
    while (output.length > 1 && context.measureText(`${output}…`).width > maxWidth) {
      output = output.slice(0, -1);
    }
    return `${output.trimEnd()}…`;
  }

  function drawCandidateCard(context, item, image, geometry, isFixed) {
    const { x, y, width, height, radius, photoWidth, numberWidth, format } = geometry;
    const selected = Boolean(item.candidate);

    context.save();
    roundedRectPath(context, x, y, width, height, radius);
    if (isFixed) {
      const fixedGradient = context.createLinearGradient(x, y, x + width, y + height);
      fixedGradient.addColorStop(0, "#12bce8");
      fixedGradient.addColorStop(1, "#0876d1");
      context.fillStyle = fixedGradient;
      context.fill();
    } else if (selected) {
      context.fillStyle = "rgba(255,255,255,0.96)";
      context.fill();
    } else {
      context.fillStyle = "rgba(255,255,255,0.075)";
      context.fill();
      context.strokeStyle = "rgba(255,255,255,0.25)";
      context.lineWidth = 2;
      context.setLineDash([9, 8]);
      context.stroke();
      context.setLineDash([]);
    }
    context.restore();

    const pad = format === "story" ? 19 : 14;
    const photoHeight = height - pad * 2;
    const photoX = x + pad;
    const photoY = y + pad;
    const textX = photoX + photoWidth + (format === "story" ? 24 : 17);
    const numberX = x + width - numberWidth - pad;
    const textWidth = numberX - textX - (format === "story" ? 20 : 14);

    if (selected) {
      drawImageCover(
        context,
        image,
        photoX,
        photoY,
        photoWidth,
        photoHeight,
        radius * 0.55,
        item.candidate.name,
        item.candidate.photoRect,
      );
    } else {
      context.save();
      roundedRectPath(context, photoX, photoY, photoWidth, photoHeight, radius * 0.55);
      context.fillStyle = "rgba(255,255,255,0.09)";
      context.fill();
      context.restore();
    }

    const roleSize = format === "story" ? 23 : 17;
    const nameStart = format === "story" ? 35 : 27;
    const nameMin = format === "story" ? 25 : 19;
    const partySize = format === "story" ? 20 : 15;

    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = isFixed ? "rgba(255,255,255,0.78)" : selected ? "#0876d1" : "rgba(255,255,255,0.58)";
    context.font = `800 ${roleSize}px Montserrat, Arial, sans-serif`;
    context.fillText(item.label.toUpperCase(), textX, y + height * 0.32);

    const name = selected ? item.candidate.name.toUpperCase() : "A DEFINIR";
    const nameSize = fitText(context, name, textWidth, nameStart, nameMin, 900);
    context.font = `900 ${nameSize}px Montserrat, Arial, sans-serif`;
    context.fillStyle = isFixed ? "#ffffff" : selected ? "#071d49" : "rgba(255,255,255,0.68)";
    context.fillText(ellipsize(context, name, textWidth), textX, y + height * 0.61);

    context.font = `700 ${partySize}px Montserrat, Arial, sans-serif`;
    context.fillStyle = isFixed ? "rgba(255,255,255,0.76)" : selected ? "#6d7890" : "rgba(255,255,255,0.4)";
    context.fillText(selected ? item.candidate.party : "DIGITE O NOME OU NÚMERO", textX, y + height * 0.81);

    context.save();
    roundedRectPath(context, numberX, photoY, numberWidth, photoHeight, radius * 0.55);
    context.fillStyle = isFixed ? "rgba(7,29,73,0.31)" : selected ? "#edf6fb" : "rgba(255,255,255,0.07)";
    context.fill();
    context.restore();

    const number = selected ? item.candidate.number : "—";
    const numberSize = format === "story" ? (number.length >= 5 ? 56 : 68) : number.length >= 5 ? 42 : 52;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = isFixed ? "#ffffff" : selected ? "#071d49" : "rgba(255,255,255,0.42)";
    context.font = `900 ${numberSize}px Montserrat, Arial, sans-serif`;
    context.fillText(number, numberX + numberWidth / 2, y + height / 2 + 2);
  }

  async function renderCanvas() {
    if (!candidateData) return;
    const token = ++renderToken;
    const isStory = selectedFormat === "story";
    const width = 1080;
    const height = isStory ? 1920 : 1350;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });

    const items = [
      { label: canvasLabels.federal, candidate: candidateData.raphael, fixed: true },
      ...slots.map((slot) => ({ label: canvasLabels[slot.id], candidate: state[slot.id], fixed: false })),
    ];
    const images = await Promise.all(items.map((item) => loadImage(item.candidate?.photo)));
    if (token !== renderToken) return;

    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#0b3d87");
    background.addColorStop(0.52, "#071f50");
    background.addColorStop(1, "#030f2c");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    context.save();
    context.globalAlpha = 0.12;
    context.strokeStyle = "#25d9ff";
    context.lineWidth = isStory ? 55 : 42;
    context.beginPath();
    context.arc(955, isStory ? 390 : 230, isStory ? 350 : 275, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = "#35b867";
    context.lineWidth = isStory ? 24 : 18;
    context.beginPath();
    context.arc(95, height - 160, isStory ? 310 : 240, 0, Math.PI * 2);
    context.stroke();
    context.restore();

    const accentSize = isStory ? 165 : 130;
    const accentGradient = context.createLinearGradient(width - accentSize, 0, width, accentSize);
    accentGradient.addColorStop(0, "#ffd54a");
    accentGradient.addColorStop(0.5, "#ffd54a");
    accentGradient.addColorStop(0.5, "#35b867");
    accentGradient.addColorStop(1, "#35b867");
    context.fillStyle = accentGradient;
    context.beginPath();
    context.moveTo(width - accentSize, 0);
    context.lineTo(width, 0);
    context.lineTo(width, accentSize);
    context.closePath();
    context.fill();

    const margin = isStory ? 66 : 62;
    const headerHeight = isStory ? 236 : 198;
    const footerHeight = isStory ? 124 : 96;
    const gap = isStory ? 18 : 13;
    const contentHeight = height - margin * 2 - headerHeight - footerHeight;
    const rowHeight = (contentHeight - gap * 5) / 6;
    const cardWidth = width - margin * 2;
    const contentY = margin + headerHeight;

    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#8feaff";
    context.font = `800 ${isStory ? 24 : 19}px Montserrat, Arial, sans-serif`;
    context.fillText("MINAS GERAIS • ELEIÇÕES 2026", margin, margin + (isStory ? 28 : 22));

    context.fillStyle = "#ffffff";
    context.font = `900 ${isStory ? 84 : 67}px Montserrat, Arial, sans-serif`;
    context.fillText("MINHA COLINHA", margin, margin + (isStory ? 120 : 100));

    context.fillStyle = "rgba(255,255,255,0.7)";
    context.font = `600 ${isStory ? 27 : 21}px Montserrat, Arial, sans-serif`;
    context.fillText("Seus números, na ordem da urna.", margin, margin + (isStory ? 168 : 141));

    const badgeWidth = isStory ? 226 : 190;
    const badgeHeight = isStory ? 62 : 50;
    const badgeX = width - margin - badgeWidth;
    const badgeY = margin + (isStory ? 178 : 146);
    context.save();
    roundedRectPath(context, badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
    context.fillStyle = "rgba(16,189,232,0.15)";
    context.fill();
    context.strokeStyle = "rgba(143,234,255,0.42)";
    context.lineWidth = 2;
    context.stroke();
    context.restore();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#b9f3ff";
    context.font = `800 ${isStory ? 20 : 16}px Montserrat, Arial, sans-serif`;
    context.fillText("RAPHAEL • 1038", badgeX + badgeWidth / 2, badgeY + badgeHeight / 2 + 1);

    items.forEach((item, index) => {
      drawCandidateCard(
        context,
        item,
        images[index],
        {
          x: margin,
          y: contentY + index * (rowHeight + gap),
          width: cardWidth,
          height: rowHeight,
          radius: isStory ? 25 : 19,
          photoWidth: isStory ? 135 : 94,
          numberWidth: isStory ? 226 : 178,
          format: isStory ? "story" : "feed",
        },
        item.fixed,
      );
    });

    const footerY = height - margin - footerHeight;
    context.fillStyle = "#ffd54a";
    context.fillRect(margin, footerY + (isStory ? 16 : 12), isStory ? 72 : 58, isStory ? 7 : 6);
    context.fillStyle = "#35b867";
    context.fillRect(margin + (isStory ? 80 : 65), footerY + (isStory ? 16 : 12), isStory ? 72 : 58, isStory ? 7 : 6);

    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#ffffff";
    context.font = `900 ${isStory ? 30 : 24}px Montserrat, Arial, sans-serif`;
    context.fillText("RAPHAEL MOTA • DEPUTADO FEDERAL 1038", margin, footerY + (isStory ? 64 : 51));
    context.fillStyle = "rgba(255,255,255,0.57)";
    context.font = `600 ${isStory ? 19 : 15}px Montserrat, Arial, sans-serif`;
    context.fillText("CONFIRA SEUS NÚMEROS ANTES DE VOTAR", margin, footerY + (isStory ? 98 : 78));
  }

  async function canvasBlob() {
    await document.fonts.ready;
    await renderCanvas();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Falha ao gerar imagem"))), "image/png", 1);
    });
  }

  async function downloadImage(showSuccess = true) {
    try {
      const blob = await canvasBlob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `colinha-raphael-1038-${selectedFormat === "story" ? "story" : "feed"}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1200);
      if (showSuccess) showToast("Imagem baixada em alta qualidade.");
    } catch {
      showToast("Não foi possível gerar a imagem. Tente novamente.");
    }
  }

  async function shareImage() {
    try {
      const blob = await canvasBlob();
      const filename = `colinha-raphael-1038-${selectedFormat === "story" ? "story" : "feed"}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: "Minha colinha — Raphael Mota 1038",
          text: "Minha colinha para as Eleições 2026.",
          files: [file],
        });
        return;
      }
      await downloadImage(false);
      showToast("Imagem baixada. Agora é só compartilhar na sua rede favorita.");
    } catch (error) {
      if (error?.name !== "AbortError") showToast("Não foi possível abrir o compartilhamento.");
    }
  }

  async function initialize() {
    try {
      const response = await fetch("data/candidates.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("Falha ao carregar candidatos");
      candidateData = await response.json();
      candidatesById = new Map(candidateData.candidates.map((candidate) => [String(candidate.id), candidate]));
      candidatesByOffice = new Map(
        ["estadual", "senador", "governador", "presidente"].map((office) => [
          office,
          candidateData.candidates.filter((candidate) => candidate.office === office),
        ]),
      );

      const raphaelPhoto = document.querySelector("#raphael-photo");
      if (candidateData.raphael.photoRect) {
        raphaelPhoto.innerHTML = spriteSvg(candidateData.raphael);
      } else if (candidateData.raphael.photo) {
        raphaelPhoto.style.backgroundImage = `url('${candidateData.raphael.photo}')`;
        raphaelPhoto.style.backgroundSize = "cover";
        raphaelPhoto.style.backgroundPosition = "center top";
      }
      document.querySelector("#source-date").textContent = ` Atualização: ${candidateData.updatedAt}.`;
      renderFields();
      updateProgress();
      await document.fonts.ready;
      await renderCanvas();
    } catch {
      fieldContainer.setAttribute("aria-busy", "false");
      fieldContainer.innerHTML = `
        <div class="candidate-field">
          <strong class="field-title">Não foi possível carregar a lista agora.</strong>
          <p class="no-results">Atualize a página e tente novamente.</p>
        </div>`;
      showToast("A lista de candidatos não carregou. Atualize a página.");
    }
  }

  document.querySelectorAll(".format-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedFormat = button.dataset.format;
      document.querySelectorAll(".format-button").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      canvasShell.classList.toggle("is-feed", selectedFormat === "feed");
      canvasShell.classList.toggle("is-story", selectedFormat === "story");
      renderCanvas();
    });
  });

  resetButton.addEventListener("click", () => {
    slots.forEach((slot) => {
      state[slot.id] = null;
    });
    renderFields();
    updateProgress();
    renderCanvas();
    showToast("Escolhas removidas. Raphael Mota 1038 continua fixo.");
  });

  downloadButton.addEventListener("click", () => downloadImage());
  shareButton.addEventListener("click", shareImage);
  initialize();
})();
