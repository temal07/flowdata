const KIND_COLORS = {
  function: "#4f8ef7",
  method: "#3fb6a8",
  class: "#e0763f",
  variable: "#8f7bdb",
  param: "#c2853f",
  type: "#3fa15e",
  import: "#c94f7c",
};
const DEFAULT_COLOR = "#999";

function shortFile(path) {
  return path.split("/").pop();
}

function locLabel(entry) {
  return `${shortFile(entry.file)}:${entry.line}`;
}

async function main() {
  const res = await fetch("/graph.json");
  const data = await res.json();
  const nodes = data.nodes;

  const kindsPresent = new Set(nodes.map((n) => n.kind));
  buildLegend(kindsPresent);

  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: [
      {
        selector: "node",
        style: {
          "background-color": (ele) => KIND_COLORS[ele.data("kind")] || DEFAULT_COLOR,
          label: "data(label)",
          "font-size": 9,
          color: "#333",
          "text-valign": "bottom",
          "text-margin-y": 4,
          width: 16,
          height: 16,
          "border-width": 0,
        },
      },
      {
        selector: "node:selected",
        style: {
          "border-width": 3,
          "border-color": "#222",
        },
      },
    ],
    layout: { name: "grid" },
    wheelSensitivity: 0.25,
  });

  function renderMatches(matches) {
    cy.elements().remove();
    hidePanel();

    if (matches.length === 0) return;

    cy.add(
      matches.map(({ n, i }) => ({
        data: { id: String(i), label: n.name, kind: n.kind, node: n },
      })),
    );
    cy.layout({
      name: "grid",
      padding: 40,
      avoidOverlap: true,
      avoidOverlapPadding: 30,
    }).run();
  }

  function selectNode(cyNode) {
    cy.elements(":selected").unselect();
    cyNode.select();
    cy.animate({ center: { eles: cyNode }, duration: 200 });
    showPanel(cyNode.data("node"));
  }

  cy.on("tap", "node", (evt) => {
    selectNode(evt.target);
  });

  cy.on("tap", (evt) => {
    if (evt.target === cy) {
      cy.elements(":selected").unselect();
      hidePanel();
    }
  });

  const searchInput = document.getElementById("search");
  const searchResults = document.getElementById("search-results");

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.innerHTML = "";

    if (!q) {
      renderMatches([]);
      return;
    }

    const matches = nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.name.toLowerCase().includes(q));

    renderMatches(matches);

    for (const { n, i } of matches.slice(0, 30)) {
      const row = document.createElement("div");
      row.className = "search-result";
      row.innerHTML = `<span class="name">${escapeHtml(n.name)}</span><span class="kind">${escapeHtml(n.kind)}</span>`;
      row.addEventListener("click", () => {
        const cyNode = cy.getElementById(String(i));
        selectNode(cyNode);
      });
      searchResults.appendChild(row);
    }
  });

  function showPanel(n) {
    document.getElementById("panel-empty").hidden = true;
    const content = document.getElementById("panel-content");
    content.hidden = false;

    document.getElementById("panel-name").textContent = n.name;

    const badge = document.getElementById("panel-kind");
    badge.textContent = n.kind;
    badge.style.background = KIND_COLORS[n.kind] || DEFAULT_COLOR;

    document.getElementById("panel-decl").textContent = locLabel(n);

    const usesList = document.getElementById("panel-uses");
    usesList.innerHTML = "";
    document.getElementById("panel-uses-count").textContent = n.uses.length;

    if (n.uses.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No recorded uses.";
      usesList.appendChild(li);
    } else {
      for (const u of n.uses) {
        const li = document.createElement("li");
        li.textContent = locLabel(u);
        usesList.appendChild(li);
      }
    }
  }

  function hidePanel() {
    document.getElementById("panel-empty").hidden = false;
    document.getElementById("panel-content").hidden = true;
  }
}

function buildLegend(kindsPresent) {
  const legend = document.getElementById("legend");
  for (const kind of Object.keys(KIND_COLORS)) {
    if (!kindsPresent.has(kind)) continue;
    const item = document.createElement("div");
    item.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = KIND_COLORS[kind];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(kind));
    legend.appendChild(item);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

main();
