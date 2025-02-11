# Network Connections Card

A **custom Lovelace card** for **Home Assistant** that visualizes network connections in an **interactive, force-directed graph** using [D3.js](https://d3js.org/). It highlights:

- **Hub** pinned at the center (e.g., your router’s IP).  
- **Ports** arranged in a star around the hub.  
- **IP addresses** “bloom” around each pinned port.  
- **Smooth updates**: No abrupt restarts on new data.  
- **Zoom & pan**: Scroll to zoom, drag to pan, drag nodes to reposition.  
- **LocalStorage**: Node positions persist across reloads.

## Features

1. **Bloom Layout**  
   Pins the hub in the center, ports in a star pattern, and IP addresses in a “bloom” around each port—providing a clear, organized view of your network.

2. **Gentle Reflows**  
   When the sensor data updates (throttled to every 5s by default), the layout transitions smoothly instead of jumping.

3. **Zoom & Pan**  
   Use mouse wheel or pinch to zoom in/out, click-and-drag the background to pan, and click-and-drag IP nodes to reposition them.

4. **Positions Saved**  
   Node positions (especially user drags) are stored in the browser’s localStorage, so your layout remains consistent on refresh.

## Installation

1. **Place the Card File**  
   - Download `network-connections-card.js` from this repository.  
   - Put it into your Home Assistant `www/` directory (e.g., `<config>/www/network-connections-card.js`).

2. **Add to Lovelace Resources**  
   - Go to Home Assistant → **Settings** → **Dashboards** → **Resources**.  
   - Create a new resource:
     ```yaml
     url: /local/network-connections-card.js
     type: module
     ```
   - “/local/” maps to the `www` folder in Home Assistant.

3. **Use the Custom Card**  
   - In your Lovelace dashboard, add a **Manual Card** with:
     ```yaml
     type: custom:network-connections-card
     entity: sensor.my_network_connections
     ```
   - Replace `sensor.my_network_connections` with the entity that holds a `connections` array in its attributes.

## Configuration

### Data Format
The card expects an attribute named `connections`, which is an array of objects like:
```json
[
  { "source": "192.168.2.10", "target": "8.8.8.8", "port": 443 },
  { "source": "192.168.2.11", "target": "192.168.2.5", "port": 80 }
]
```

Your sensor’s state or attributes should expose this. The card automatically builds the force graph from these entries.

### Panel Mode (Optional)
To fully utilize the card’s layout and zoom features, put the view in Panel Mode (so it can occupy the entire page).

### Usage
1. View & Zoom
  * Scroll or pinch to zoom in/out.
  * Click-and-drag background to pan the graph.
  * If you grab an IP node, you can move it freely. Ports and the hub are pinned.

2. Positions

The card stores node positions in localStorage under a key like:
```
networkPositions_sensor.my_network_connections
```
If you need a fresh layout, open your browser dev tools and remove that key.

3. Inbound/Outbound (Optional)
If your data has direction (source vs. target), you can color or add arrow markers to differentiate inbound vs. outbound traffic. See the comments in the JS file.

### Troubleshooting

* Card Doesn’t Appear?
  * Verify the resource URL is correct (/local/...) and type: module.
  * Ensure the custom card YAML references custom:network-connections-card.
* No Data or Nodes?
  * Check if your entity actually has the connections attribute.
  * Ensure you spelled entity: correctly in the card config.
* Nodes Overlap?
  * Adjust collision radius in the JS code: .forceCollide().radius(...).

### License
This card is distributed under the MIT License. Refer to LICENSE for details.

### Acknowledgements
* Built using D3.js (v6) for force simulations and interactive graphs.
* Inspired by various D3 force layout examples adapted for Home Assistant’s Lovelace environment.
Disclaimer: This is a community project, not affiliated with Home Assistant or any networking hardware vendors. Use at your own risk and ensure no sensitive network data is exposed in your Lovelace UI.
