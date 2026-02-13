# 🚇 NYC Subway Live Tracker

<p align="center">
  <img src="/.github/images/demo-screenshot-topdown.jpg" alt="Project Demo Screenshot" width="800">
</p>

## 🗽 Overview 
A high-performance geospatial application visualizing live MTA transit data on a high-fidelity 3D globe. This project serves as a template for bridging the gap between complex binary Protobuf transit feeds and browser-based 3D visualization using **CesiumJS**.

[Live Demo Link](https://nyc-subway-tracker-kappa.vercel.app/) | [MTA API Documentation](https://api.mta.info/#/)

## 🛠️ Tech Stack
* **Frontend**: CesiumJS for 3D rendering and dynamic Entity management.
* **Backend**: Node.js Serverless Functions (Vercel) for secure Protobuf decoding.
* **Styling**: Custom CSS for a modern, HUD-style transit interface.

## 🌐 Tiles & Data
This app integrates three distinct data layers:
1.  **Curated Data:** Leverages **Cesium World Terrain** and **New York City 3D Buildings from Cesium Ion** for global context.
2.  **Tiled User Data:** Includes a [custom 3D model of Manhattan](https://sketchfab.com/3d-models/new-york-city-manhattan-372bc495b3a941308f4a3198bc45e17b) uploaded and processed via the Cesium Ion tiling pipeline. The model is georeferenced to anchor precisely at NYC coordinates.
3.  **Third-Party Real-Time Data:** Integrates the **MTA GTFS-Realtime API**. Binary Protobuf feeds are decoded server-side via Node.js to circumvent CORS and optimize payload delivery.

## 📡 Data Pipeline
To handle the complexity of NYC's transit data, the application follows a robust processing flow:
1. **Ingestion**: Fetches binary GTFS-Realtime (GTFS-R) feeds from the MTA's Protobuf endpoints.
2. **Decoding**: Processes binary payloads using gtfs-realtime-bindings.
3. **Spatial Mapping**: Cross-references real-time Stop IDs with static stops.txt datasets to resolve train coordinates.
4. **Visualization**: Streams optimized JSON to the CesiumJS frontend for real-time entity updates.

## ✨ Key Features
* **Real-time Tracking**: Live synchronization of subway car positions across the five boroughs.
* **Urban Context**: Integrated Manhattan 3D Buildings (via Cesium Ion) to provide depth and architectural scale.
* **Performance Optimized**: Leverages the Cesium Entity API for smooth data polling and low-latency updates.

## 💻 Setup & Installation

This project uses a Server-Side Config Pattern. The frontend does not store API keys; instead, it fetches them from a secure backend endpoint (/api/config).

### Prerequisites
You will need the following:
* [Cesium Ion](https://ion.cesium.com/) Access Token
* [Node.js](https://nodejs.org/) installed on your machine

### Local Setup:
1. Clone or download repo
```bash
git clone https://github.com/PaulANathan/nyc-subway-tracker.git
cd nyc-subway-tracker
```
2. Create a .env file in the root directory.
3. Add credential to .env file:
```env
CESIUM_TOKEN=your_cesium_ion_token
```
4. Make sure the [NYC 3D Buildings](https://ion.cesium.com/assetdepot/75343) data is enabled for your Cesium Ion account
5. Install & Run
```bash
npm install
npm start
```
6. Navigate to http://localhost:3000 to open app

## ⚖️ License
Distributed under the MIT License. See [LICENSE](https://github.com/PaulANathan/nyc-subway-tracker/tree/main?tab=MIT-1-ov-file) for more information.
