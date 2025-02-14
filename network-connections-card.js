class NetworkConnectionsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._attachD3Script();
    this.lastUpdate = Date.now();

    this._nodesMap = {};
    this._links = [];
    this._prevConnections = []; // For diffing
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
          overflow: hidden;
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
    this.hubId = config.hubId || "192.168.2.1";
  }

  set hass(hass) {
    if (!this.content) return;

    const entityId = this.config?.entity;
    if (!entityId) return;

    const state = hass.states[entityId];
    if (!state?.attributes?.connections) return;

    const now = Date.now();
    if (now - this.lastUpdate < 5000) return; // Throttle updates
    this.lastUpdate = now;

    this._deltaUpdate(state.attributes.connections);
  }

  getCardSize() {
    return 8;
  }

  /**
   * Lazy-update: diff the new connections with the previous ones,
   * then update the nodes and links accordingly.
   */
  _deltaUpdate(newConnections) {
    // Filter out loopback entries.
    const connections = newConnections.filter(({ source, target }) =>
      source !== "127.0.0.1" && target !== "127.0.0.1"
    );

    // Helper to build a unique key for a connection.
    const connectionKey = ({ source, target, port }) =>
      `${source}_${target}_${port}`;

    // Build sets for old and new connections.
    const oldKeys = new Set(this._prevConnections.map(connectionKey));
    const newKeys = new Set(connections.map(connectionKey));

    // Determine added and removed connections.
    const addedConnections = connections.filter(
      (conn) => !oldKeys.has(connectionKey(conn))
    );
    const removedConnections = this._prevConnections.filter(
      (conn) => !newKeys.has(connectionKey(conn))
    );

    // Save the latest connections.
    this._prevConnections = connections;

    // Center coordinates.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = width / 2;
    const centerY = height / 2;

    // Ensure the hub is always present and pinned.
    if (!this._nodesMap[this.hubId]) {
      this._nodesMap[this.hubId] = {
        id: this.hubId,
        type: "hub",
        fx: centerX,
        fy: centerY,
      };
    }

    // Process ports with a star layout.
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
        this._nodesMap[portNodeId] = {
          id: portNodeId,
          type: "port",
          label: `Port ${port}`,
          fx: portX,
          fy: portY,
        };
      }
    });

    // Process added connections.
    addedConnections.forEach(({ source, target, port }) => {
      const portNodeId = `port-${port}`;

      if (!this._nodesMap[source]) {
        this._nodesMap[source] = { id: source, type: "ip" };
        this._placeIpNearPort(source, portNodeId);
      }
      if (!this._nodesMap[target]) {
        this._nodesMap[target] = { id: target, type: "ip" };
        this._placeIpNearPort(target, portNodeId);
      }

      // Add links between IP and port.
      if (this._nodesMap[source].type === "ip") {
        this._links.push({ source, target: portNodeId });
      }
      if (this._nodesMap[target].type === "ip") {
        this._links.push({ source: portNodeId, target });
      }
    });

    // Process removed connections.
    removedConnections.forEach(({ source, target, port }) => {
      const portNodeId = `port-${port}`;
      this._links = this._links.filter((l) => {
        const key = (l.source.id || l.source) + "->" + (l.target.id || l.target);
        const removeKey1 = source + "->" + portNodeId;
        const removeKey2 = portNodeId + "->" + target;
        return key !== removeKey1 && key !== removeKey2;
      });
    });

    // Ensure each port is connected to the hub.
    uniquePorts.forEach((port) => {
      const hubPortLink = { source: this.hubId, target: `port-${port}` };
      const exists = this._links.some((l) => {
        const key = (l.source.id || l.source) + "->" + (l.target.id || l.target);
        const desired = this.hubId + "->" + `port-${port}`;
        return key === desired;
      });
      if (!exists) {
        this._links.push(hubPortLink);
      }
    });

    // Remove nodes that are no longer referenced.
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

    // --- Update or create the simulation ---
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
      this.simulation.nodes(Object.values(this._nodesMap));
      this.simulation.force("link").links(this._links);
      // Instead of forcing an alpha target and resetting it later,
      // we gently restart the simulation by setting a new alpha value.
      this.simulation.alpha(0.3).restart();
    }

    // Update the D3 rendering using data joins.
    this._renderD3();
  }

  /**
   * Place an IP node near its corresponding port.
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

  /**
   * Render (or update) nodes, links, and labels using D3 data joins.
   */
  _renderD3() {
    const svg = d3.select(this.shadowRoot.querySelector("#network-graph"));
    const g = svg.select("#zoom-group");

    if (!this._zoom) {
      this._zoom = d3.zoom()
        .scaleExtent([0.3, 5])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        });
      svg.call(this._zoom);
    }

    this._setupArrowMarkers(svg);

    // Data join for links.
    const linkSel = g.selectAll("line.link")
      .data(this._links, d => (d.source.id || d.source) + "_" + (d.target.id || d.target));
    linkSel.exit().remove();
    const linkEnter = linkSel.enter()
      .append("line")
      .attr("class", "link")
      .attr("stroke-width", 2);
    linkSel.merge(linkEnter)
      .attr("stroke", d => {
        if (this._isInbound(d)) return "green";
        if (this._isOutbound(d)) return "orange";
        return "#6fa3ef";
      })
      .attr("marker-end", d => {
        if (this._isInbound(d)) return "url(#arrowInbound)";
        if (this._isOutbound(d)) return "url(#arrowOutbound)";
        return null;
      });

    // Data join for nodes.
    const nodeSel = g.selectAll("circle.node")
      .data(Object.values(this._nodesMap), d => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter()
      .append("circle")
      .attr("class", "node")
      .call(
        d3.drag()
          .on("start", (event, d) => this._dragStarted(event, d))
          .on("drag", (event, d) => this._dragged(event, d))
          .on("end", (event, d) => this._dragEnded(event, d))
      );
    nodeSel.merge(nodeEnter)
      .attr("r", d => d.type === "port" ? 12 : d.type === "hub" ? 20 : 10)
      .attr("fill", d => {
        if (d.type === "hub") return "#2ecc71";
        if (d.type === "port") return "#ff5733";
        return "#f39c12";
      });

    // Data join for labels.
    const labelSel = g.selectAll("text.label")
      .data(Object.values(this._nodesMap), d => d.id);
    labelSel.exit().remove();
    const labelEnter = labelSel.enter()
      .append("text")
      .attr("class", "label")
      .attr("dx", 15)
      .attr("dy", 4);
    labelSel.merge(labelEnter)
      .text(d => d.label || d.id);

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
   * Define arrow markers for inbound (green) and outbound (orange) links.
   */
  _setupArrowMarkers(svg) {
    const defs = svg.select("#markers-defs");
    if (defs.select("#arrowInbound").empty()) {
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
   * Helper: returns true if the link is inbound (IP -> port).
   */
  _isInbound(d) {
    const s = this._getNodeType(d.source);
    const t = this._getNodeType(d.target);
    return s === "ip" && t === "port";
  }

  /**
   * Helper: returns true if the link is outbound (port -> IP).
   */
  _isOutbound(d) {
    const s = this._getNodeType(d.source);
    const t = this._getNodeType(d.target);
    return s === "port" && t === "ip";
  }

  /**
   * Return the type of a node (object or string reference).
   */
  _getNodeType(ref) {
    if (typeof ref === "object") {
      return ref.type;
    } else {
      const nodeObj = this._nodesMap[ref];
      return nodeObj ? nodeObj.type : undefined;
    }
  }

  /**
   * Update positions on each simulation tick.
   */
  _onTick() {
    const g = d3.select(this.shadowRoot.querySelector("#zoom-group"));
    g.selectAll("line.link")
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
    g.selectAll("circle.node")
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);
    g.selectAll("text.label")
      .attr("x", d => d.x + 10)
      .attr("y", d => d.y + 5);

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
      // Ignore errors.
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
