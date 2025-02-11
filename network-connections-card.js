class NetworkConnectionsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._attachD3Script();
    this.lastUpdate = Date.now();

    this._nodesMap = {};
    this._links = [];
    this.simulation = null;
    this._positionsRestored = false;
    this._zoom = null;
    this._hasInitialZoom = false;
  }

  _attachD3Script() {
    if (window.d3) {
      this._init();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://d3js.org/d3.v6.min.js";
    script.onload = () => this._init();
    document.head.appendChild(script);
  }

  _init() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100vw;
          height: 100vh;
          margin: 0;
          padding: 0;
          overflow: hidden; /* hide scrollbars; rely on pan/zoom */
        }
        svg {
          width: 100%;
          height: 100%;
          background: transparent;
        }
        text {
          fill: black;
          font-size: 14px;
        }
      </style>
      <svg id="network-graph">
        <!-- We'll attach arrow markers in <defs> here if not present -->
        <defs id="markers-defs"></defs>
        <g id="zoom-group"></g>
      </svg>
    `;
    this.content = this.shadowRoot.querySelector("#network-graph");
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("You need to define an entity");
    }
    this.config = config;

    // Define a default hub IP
    this.hubId = config.hubId || "192.168.2.1";
  }

  set hass(hass) {
    if (!this.content) return;

    const entityId = this.config?.entity;
    if (!entityId) return;

    const state = hass.states[entityId];
    if (!state?.attributes?.connections) return;

    const now = Date.now();
    // Throttle updates to every 5 seconds
    if (now - this.lastUpdate < 5000) return;
    this.lastUpdate = now;

    // console.log("🔵 Data received:", state.attributes.connections);

    this._deltaUpdate(state.attributes.connections);
  }

  getCardSize() {
    return 8;
  }

  /**
   * MAIN: Filter out 127.0.0.1, pin hub + ports in star layout,
   *       "bloom" IPs around each port, then an incremental update.
   */
  _deltaUpdate(connections) {
    // Remove loopback
    connections = connections.filter(({ source, target }) =>
      source !== "127.0.0.1" && target !== "127.0.0.1"
    );

    // Center coords
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = width / 2;
    const centerY = height / 2;

    // Ensure hub pinned
    if (!this._nodesMap[this.hubId]) {
      this._nodesMap[this.hubId] = {
        id: this.hubId,
        type: "hub",
        fx: centerX,
        fy: centerY,
      };
    }

    // Gather ports in star layout
    const uniquePorts = Array.from(new Set(connections.map(c => c.port)));
    const portsPerStar = 8;
    const baseRadius = Math.min(width, height) * 0.3;
    const ringSpacing = 150; 
    const starOuterRatio = 1.0;
    const starInnerRatio = 0.5;

    uniquePorts.forEach((port, i) => {
      const portNodeId = `port-${port}`;
      if (!this._nodesMap[portNodeId]) {
        const ringIndex = Math.floor(i / portsPerStar);
        const starIndex = i % portsPerStar;
        const ringBase = baseRadius + ringIndex * ringSpacing;
        const isOuter = starIndex % 2 === 0;
        const starRadius = isOuter
          ? ringBase * starOuterRatio
          : ringBase * starInnerRatio;

        const angle = (2 * Math.PI / portsPerStar) * starIndex;
        const portX = centerX + Math.cos(angle) * starRadius;
        const portY = centerY + Math.sin(angle) * starRadius;

        // pinned port
        this._nodesMap[portNodeId] = {
          id: portNodeId,
          type: "port",
          label: `Port ${port}`,
          fx: portX,
          fy: portY,
        };
      }
    });

    // Build IP nodes & links
    const newLinks = [];
    connections.forEach(({ source, target, port }) => {
      const portNodeId = `port-${port}`;

      // If "source" is an IP not present, place near port
      if (!this._nodesMap[source]) {
        this._nodesMap[source] = { id: source, type: "ip" };
        this._placeIpNearPort(source, portNodeId);
      }
      // If "target" is an IP not present, place near port
      if (!this._nodesMap[target]) {
        this._nodesMap[target] = { id: target, type: "ip" };
        this._placeIpNearPort(target, portNodeId);
      }

      // link IP(s) to port (undirected, but we'll label them for direction)
      if (this._nodesMap[source].type === "ip") {
        newLinks.push({ source, target: portNodeId });
      }
      if (this._nodesMap[target].type === "ip") {
        newLinks.push({ source: portNodeId, target });
      }
    });

    // Link each port to hub if desired
    uniquePorts.forEach((port) => {
      newLinks.push({
        source: this.hubId,
        target: `port-${port}`,
      });
    });

    // Sync old & new
    this._syncNodesAndLinks(newLinks);

    // Restore positions if not yet
    if (!this._positionsRestored) {
      this._restoreNodePositions();
      this._positionsRestored = true;
    }

    // Create or update simulation
    if (!this.simulation) {
      this.simulation = d3.forceSimulation(Object.values(this._nodesMap))
        .force("link", d3.forceLink(this._links)
          .id((d) => d.id)
          .distance(80)
          .strength(0.5)
        )
        .force("charge", d3.forceManyBody().strength(-200))
        .force("collision", d3.forceCollide().radius(30))
        .alphaDecay(0.02)
        .alphaMin(0.05)
        .on("tick", () => this._onTick());
    } else {
      // Gentle "nudge" rather than abrupt
      this.simulation.nodes(Object.values(this._nodesMap));
      this.simulation.force("link").links(this._links);
      this.simulation.alphaTarget(0.2).restart();
      setTimeout(() => {
        this.simulation?.alphaTarget(0);
      }, 1000);
    }

    // Render
    this._renderD3();
  }

  /**
   * Place IP near its port so it starts in a bloom around the port.
   */
  _placeIpNearPort(ipId, portNodeId) {
    const portNode = this._nodesMap[portNodeId];
    if (!portNode) return;
    const angle = Math.random() * 2 * Math.PI;
    const radius = 50;
    const ipX = portNode.fx + Math.cos(angle) * radius;
    const ipY = portNode.fy + Math.sin(angle) * radius;
    this._nodesMap[ipId].x = ipX;
    this._nodesMap[ipId].y = ipY;
  }

  _syncNodesAndLinks(newLinks) {
    const linkKey = (l) => (l.source.id || l.source) + "->" + (l.target.id || l.target);
    const newLinkSet = new Set(newLinks.map(linkKey));

    this._links = this._links.filter((oldL) => newLinkSet.has(linkKey(oldL)));
    const oldLinkSet = new Set(this._links.map(linkKey));
    newLinks.forEach((nl) => {
      if (!oldLinkSet.has(linkKey(nl))) {
        this._links.push(nl);
      }
    });

    const usedNodeIds = new Set();
    this._links.forEach((l) => {
      usedNodeIds.add(l.source.id || l.source);
      usedNodeIds.add(l.target.id || l.target);
    });
    usedNodeIds.add(this.hubId);

    Object.keys(this._nodesMap).forEach((nid) => {
      if (!usedNodeIds.has(nid)) {
        delete this._nodesMap[nid];
      }
    });
  }

  /**
   * Render nodes, links, labels. Also define arrow markers for inbound/outbound.
   */
  _renderD3() {
    const svg = d3.select(this.shadowRoot.querySelector("#network-graph"));
    const g = svg.select("#zoom-group");

    // If zoom not set up, do it now
    if (!this._zoom) {
      this._zoom = d3.zoom()
        .scaleExtent([0.3, 5])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        });
      svg.call(this._zoom);
    }

    // 1) Ensure arrow markers exist
    this._setupArrowMarkers(svg);

    // 2) Data join on links
    const linkSel = g.selectAll("line.link")
      .data(this._links, (d) => (d.source.id || d.source) + "_" + (d.target.id || d.target));

    linkSel.exit().remove();
    const linkEnter = linkSel.enter()
      .append("line")
      .attr("class", "link");

    // Merge
    const linkMerged = linkSel.merge(linkEnter);

    // Set color + arrow for inbound/outbound/hub
    linkMerged
      .attr("stroke-width", 2)
      .attr("stroke", (d) => {
        if (this._isInbound(d)) return "green";   // IP->port
        if (this._isOutbound(d)) return "orange"; // port->IP
        return "#6fa3ef"; // default (hub or unknown)
      })
      .attr("marker-end", (d) => {
        if (this._isInbound(d)) return "url(#arrowInbound)";   // green arrow
        if (this._isOutbound(d)) return "url(#arrowOutbound)"; // orange arrow
        return null; // no arrow for hub<->port
      });

    // 3) Data join on nodes
    const nodeSel = g.selectAll("circle.node")
      .data(Object.values(this._nodesMap), (d) => d.id);

    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter()
      .append("circle")
      .attr("class", "node")
      .attr("r", (d) => d.type === "port" ? 12 : d.type === "hub" ? 20 : 10)
      .attr("fill", (d) => {
        if (d.type === "hub") return "#2ecc71";   // green
        if (d.type === "port") return "#ff5733";  // red/orange
        return "#f39c12";                         // IP
      })
      .call(
        d3.drag()
          .on("start", (event, d) => this._dragStarted(event, d))
          .on("drag", (event, d) => this._dragged(event, d))
          .on("end", (event, d) => this._dragEnded(event, d))
      );

    nodeSel.merge(nodeEnter);

    // 4) Data join on labels
    const labelSel = g.selectAll("text.label")
      .data(Object.values(this._nodesMap), (d) => d.id);

    labelSel.exit().remove();
    const labelEnter = labelSel.enter()
      .append("text")
      .attr("class", "label")
      .attr("dx", 15)
      .attr("dy", 4)
      .text((d) => d.label || d.id);

    labelSel.merge(labelEnter);

    // 5) Optional: initial zoom out
    if (!this._hasInitialZoom) {
      this._hasInitialZoom = true;
      const w = window.innerWidth;
      const h = window.innerHeight;
      svg.call(
        this._zoom.transform,
        d3.zoomIdentity
          .translate(w / 2, h / 2)
          .scale(0.7)
          .translate(-w / 2, -h / 2)
      );
    }
  }

  /**
   * Define arrow markers in <defs> if not already present.
   * We'll create two: #arrowInbound (green) and #arrowOutbound (orange).
   */
  _setupArrowMarkers(svg) {
    const defs = svg.select("#markers-defs");
    if (defs.select("#arrowInbound").empty()) {
      // inbound arrow
      defs.append("marker")
        .attr("id", "arrowInbound")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "green");
    }
    if (defs.select("#arrowOutbound").empty()) {
      // outbound arrow
      defs.append("marker")
        .attr("id", "arrowOutbound")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "orange");
    }
  }

  /**
   * Helper: inbound = IP -> port
   */
  _isInbound(d) {
    const s = this._getNodeType(d.source);
    const t = this._getNodeType(d.target);
    return (s === "ip" && t === "port");
  }

  /**
   * Helper: outbound = port -> IP
   */
  _isOutbound(d) {
    const s = this._getNodeType(d.source);
    const t = this._getNodeType(d.target);
    return (s === "port" && t === "ip");
  }

  /**
   * Return the 'type' of a node reference (which might be an object or ID).
   */
  _getNodeType(ref) {
    // ref might be an object with .type, or a string if uninitialized
    if (typeof ref === "object") {
      return ref.type;
    } else {
      // Look up in _nodesMap
      const nodeObj = this._nodesMap[ref];
      return nodeObj ? nodeObj.type : undefined;
    }
  }

  /**
   * Force simulation tick => update positions
   */
  _onTick() {
    const g = d3.select(this.shadowRoot.querySelector("#zoom-group"));

    g.selectAll("line.link")
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    g.selectAll("circle.node")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y);

    g.selectAll("text.label")
      .attr("x", (d) => d.x + 10)
      .attr("y", (d) => d.y + 5);

    // Save positions once mostly settled
    if (this.simulation.alpha() < 0.05) {
      this._saveNodePositions();
    }
  }

  /** D3 Drag callbacks */
  _dragStarted(event, d) {
    if (!event.active) this.simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  _dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  _dragEnded(event, d) {
    if (!event.active) this.simulation.alphaTarget(0);
    // Keep hub & ports pinned, IP addresses float
    if (d.type === "ip") {
      d.fx = null;
      d.fy = null;
    }
    this._saveNodePositions();
  }

  _saveNodePositions() {
    const storageKey = `networkPositions_${this.config.entity}`;
    const positions = {};
    for (const [id, node] of Object.entries(this._nodesMap)) {
      positions[id] = {
        x: node.x,
        y: node.y,
        fx: node.fx,
        fy: node.fy,
      };
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(positions));
    } catch (err) {
      console.warn("Error saving node positions:", err);
    }
  }

  _restoreNodePositions() {
    const storageKey = `networkPositions_${this.config.entity}`;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey));
    } catch (err) {
      // ignore parse errors
    }
    if (!saved) return;

    Object.entries(saved).forEach(([id, pos]) => {
      const node = this._nodesMap[id];
      if (node) {
        if (typeof pos.x === "number") node.x = pos.x;
        if (typeof pos.y === "number") node.y = pos.y;
        if (typeof pos.fx === "number") node.fx = pos.fx;
        if (typeof pos.fy === "number") node.fy = pos.fy;
      }
    });
  }

  disconnectedCallback() {
    if (this.simulation) {
      this.simulation.stop();
    }
  }
}

customElements.define("network-connections-card", NetworkConnectionsCard);
