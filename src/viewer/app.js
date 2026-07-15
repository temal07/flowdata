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
  const edges = data.edges || [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  document.getElementById("viewing").textContent = `Viewing "${shortFile(data.root)}"`;

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
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": "#bbb",
          "target-arrow-color": "#bbb",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          opacity: 0.8,
        },
      },
      {
        selector: "edge:selected",
        style: {
          width: 3,
          "line-color": "#6b8afd",
          "target-arrow-color": "#6b8afd",
          opacity: 1,
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

    const shownIds = new Set(matches.map(({ n }) => n.id));

    cy.add(
      matches.map(({ n }) => ({
        data: { id: n.id, label: n.name, kind: n.kind, node: n },
      })),
    );

    // only draw feeds edges where both the owning and fed declaration
    // are currently on screen
    cy.add(
      edges
        .filter((e) => shownIds.has(e.source) && shownIds.has(e.target))
        .map((e, i) => ({
          data: { id: `e${i}`, source: e.source, target: e.target, occurrences: e.occurrences || [] },
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

  function selectEdge(cyEdge) {
    cy.elements(":selected").unselect();
    cyEdge.select();
    showEdgePanel(cyEdge.data());
  }

  cy.on("tap", "node", (evt) => {
    selectNode(evt.target);
  });

  cy.on("tap", "edge", (evt) => {
    selectEdge(evt.target);
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
      .map((n) => ({ n }))
      .filter(({ n }) => n.name.toLowerCase().includes(q));

    renderMatches(matches);

    for (const { n } of matches.slice(0, 30)) {
      const row = document.createElement("div");
      row.className = "search-result";
      row.innerHTML = `<span class="name">${escapeHtml(n.name)}</span><span class="kind">${escapeHtml(n.kind)}</span>`;
      row.addEventListener("click", () => {
        const cyNode = cy.getElementById(n.id);
        selectNode(cyNode);
      });
      searchResults.appendChild(row);
    }
  });

  function showPanel(n) {
    document.getElementById("panel-empty").hidden = true;
    document.getElementById("panel-edge-content").hidden = true;
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

  function showEdgePanel(edge) {
    document.getElementById("panel-empty").hidden = true;
    document.getElementById("panel-content").hidden = true;
    const content = document.getElementById("panel-edge-content");
    content.hidden = false;

    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    document.getElementById("panel-edge-title").textContent =
      `${source?.name ?? "?"} → ${target?.name ?? "?"}`;

    const list = document.getElementById("panel-edge-uses");
    list.innerHTML = "";
    const occurrences = edge.occurrences || [];

    if (occurrences.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No recorded use sites.";
      list.appendChild(li);
    } else {
      for (const occ of occurrences) {
        const li = document.createElement("li");
        li.className = "code-occurrence";
        li.innerHTML =
          `<div class="loc">${escapeHtml(shortFile(occ.file))}:${occ.line}</div>` +
          `<code>${escapeHtml(occ.code)}</code>`;
        list.appendChild(li);
      }
    }
  }

  function hidePanel() {
    document.getElementById("panel-empty").hidden = false;
    document.getElementById("panel-content").hidden = true;
    document.getElementById("panel-edge-content").hidden = true;
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
